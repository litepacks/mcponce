import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMcpServer, McpApp } from '../src/index.js';
import {
  executeWithRetry,
  sleepWithSignal,
  extractRetryAfterMs,
  computeBackoffDelay,
  parseRetryAfterValue
} from '../src/utils/retry.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Automatic Tool Retries with Exponential Backoff', () => {
  let app: McpApp;
  let testDataDir: string;

  describe('Unit: executeWithRetry and sleepWithSignal', () => {
    it('resolves immediately without retry if fn succeeds on first attempt', async () => {
      let attempts = 0;
      const res = await executeWithRetry(async () => {
        attempts++;
        return 'ok';
      }, {
        name: 'test-tool',
        config: 3
      });

      expect(res.result).toBe('ok');
      expect(res.retries).toBe(0);
      expect(attempts).toBe(1);
    });

    it('retries with backoff and succeeds on subsequent attempt', async () => {
      let attempts = 0;
      const retryEvents: { attempt: number; delayMs: number }[] = [];

      const res = await executeWithRetry(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error(`Failure on attempt ${attempts}`);
          }
          return 'recovered';
        },
        {
          name: 'flaky-tool',
          config: {
            attempts: 3,
            backoffMs: 10,
            factor: 2
          },
          onRetry: (_err, attempt, delayMs) => {
            retryEvents.push({ attempt, delayMs });
          }
        }
      );

      expect(res.result).toBe('recovered');
      expect(res.retries).toBe(2);
      expect(attempts).toBe(3);
      expect(retryEvents).toEqual([
        { attempt: 1, delayMs: 10 },
        { attempt: 2, delayMs: 20 }
      ]);
    });

    it('aborts sleepWithSignal immediately when AbortSignal triggers', async () => {
      const controller = new AbortController();
      const start = Date.now();

      setTimeout(() => controller.abort(new Error('Interrupted!')), 20);

      await expect(sleepWithSignal(1000, controller.signal)).rejects.toThrow('Interrupted!');
      expect(Date.now() - start).toBeLessThan(200);
    });

    it('respects retryIf filter and stops immediately on non-retryable error', async () => {
      let attempts = 0;

      await expect(
        executeWithRetry(
          async () => {
            attempts++;
            throw new Error('FatalAuthenticationError');
          },
          {
            name: 'auth-tool',
            config: {
              attempts: 3,
              backoffMs: 10,
              retryIf: (err) => !err.message.includes('Fatal')
            }
          }
        )
      ).rejects.toThrow('FatalAuthenticationError');

      expect(attempts).toBe(1);
    });

    describe('Retry-After parsing and extraction', () => {
      it('correctly parses numbers, strings, and HTTP date formats in parseRetryAfterValue', () => {
        expect(parseRetryAfterValue(5)).toBe(5000);
        expect(parseRetryAfterValue(0.5)).toBe(500);
        expect(parseRetryAfterValue('3')).toBe(3000);
        expect(parseRetryAfterValue('  2.5  ')).toBe(2500);
        expect(parseRetryAfterValue('invalid')).toBeNull();
        expect(parseRetryAfterValue('')).toBeNull();
        expect(parseRetryAfterValue(-1)).toBeNull();

        // Future HTTP date
        const futureDate = new Date(Date.now() + 5000).toUTCString();
        const diff = parseRetryAfterValue(futureDate);
        expect(diff).not.toBeNull();
        expect(diff!).toBeGreaterThan(3000);
        expect(diff!).toBeLessThanOrEqual(5500);

        // Past HTTP date returns 0
        const pastDate = new Date(Date.now() - 10000).toUTCString();
        expect(parseRetryAfterValue(pastDate)).toBe(0);
      });

      it('extracts retry delay from various error structures', () => {
        expect(extractRetryAfterMs(null)).toBeNull();
        expect(extractRetryAfterMs('not-an-object')).toBeNull();

        // 1. Direct retryAfterMs
        expect(extractRetryAfterMs({ retryAfterMs: 1500 })).toBe(1500);

        // 2. retryAfter numeric seconds
        expect(extractRetryAfterMs({ retryAfter: 4 })).toBe(4000);

        // 3. retryAfter string
        expect(extractRetryAfterMs({ retryAfter: '2' })).toBe(2000);

        // 4. Fetch-style Headers object
        const mockHeaders = {
          get(key: string) {
            return key.toLowerCase() === 'retry-after' ? '6' : null;
          }
        };
        expect(extractRetryAfterMs({ response: { headers: mockHeaders } })).toBe(6000);
        expect(extractRetryAfterMs({ headers: mockHeaders })).toBe(6000);

        // 5. Plain object headers
        expect(extractRetryAfterMs({ headers: { 'retry-after': '3' } })).toBe(3000);
        expect(extractRetryAfterMs({ headers: { 'Retry-After': '7' } })).toBe(7000);
        expect(extractRetryAfterMs({ response: { headers: { 'retry-after': '8' } } })).toBe(8000);
      });
    });

    describe('Exponential backoff and randomized jitter calculation', () => {
      it('computes deterministic delay when jitter is false or undefined', () => {
        expect(computeBackoffDelay(1, 100, 2, 5000)).toBe(100);
        expect(computeBackoffDelay(2, 100, 2, 5000)).toBe(200);
        expect(computeBackoffDelay(3, 100, 2, 5000)).toBe(400);
        expect(computeBackoffDelay(10, 100, 2, 1000)).toBe(1000); // capped at maxBackoffMs
      });

      it('applies Equal Jitter when jitter is true', () => {
        for (let i = 0; i < 20; i++) {
          const delay = computeBackoffDelay(2, 100, 2, 5000, true);
          // attempt 2 base delay is 200ms. Equal jitter is [100ms, 200ms]
          expect(delay).toBeGreaterThanOrEqual(100);
          expect(delay).toBeLessThanOrEqual(200);
        }
      });

      it('applies proportional jitter when jitter is a number (e.g. 0.2 for +/-20%)', () => {
        for (let i = 0; i < 20; i++) {
          const delay = computeBackoffDelay(2, 100, 2, 5000, 0.2);
          // attempt 2 base delay is 200ms. 200 * (1 - 0.2) = 160ms, 200 * (1 + 0.2) = 240ms
          expect(delay).toBeGreaterThanOrEqual(160);
          expect(delay).toBeLessThanOrEqual(240);
        }
      });
    });

    describe('executeWithRetry with Retry-After and jitter', () => {
      it('respects Retry-After header and uses the specified delay', async () => {
        let attempts = 0;
        const retryDelays: number[] = [];

        const res = await executeWithRetry(
          async () => {
            attempts++;
            if (attempts < 2) {
              const err: any = new Error('Rate Limited');
              err.retryAfterMs = 15;
              throw err;
            }
            return 'recovered-after-429';
          },
          {
            name: 'rate-limited-tool',
            config: {
              maxRetries: 3,
              backoffMs: 100, // normally 100ms
              respectRetryAfter: true
            },
            onRetry: (_err, _attempt, delayMs) => {
              retryDelays.push(delayMs);
            }
          }
        );

        expect(res.result).toBe('recovered-after-429');
        expect(res.retries).toBe(1);
        expect(attempts).toBe(2);
        expect(retryDelays).toEqual([15]); // Respected 15ms instead of 100ms
      });

      it('ignores Retry-After when respectRetryAfter is false', async () => {
        let attempts = 0;
        const retryDelays: number[] = [];

        const res = await executeWithRetry(
          async () => {
            attempts++;
            if (attempts < 2) {
              const err: any = new Error('Rate Limited');
              err.retryAfterMs = 500;
              throw err;
            }
            return 'recovered-ignoring-header';
          },
          {
            name: 'ignore-retry-after-tool',
            config: {
              maxRetries: 2,
              backoffMs: 10,
              respectRetryAfter: false
            },
            onRetry: (_err, _attempt, delayMs) => {
              retryDelays.push(delayMs);
            }
          }
        );

        expect(res.result).toBe('recovered-ignoring-header');
        expect(retryDelays).toEqual([10]); // Used backoffMs (10ms) instead of retryAfterMs (500ms)
      });

      it('applies jitter in executeWithRetry', async () => {
        let attempts = 0;
        const retryDelays: number[] = [];

        await executeWithRetry(
          async () => {
            attempts++;
            if (attempts < 2) {
              throw new Error('Temporary glitch');
            }
            return 'jitter-success';
          },
          {
            name: 'jitter-tool',
            config: {
              maxRetries: 2,
              backoffMs: 40,
              jitter: 0.1 // +/- 10% -> 36ms to 44ms
            },
            onRetry: (_err, _attempt, delayMs) => {
              retryDelays.push(delayMs);
            }
          }
        );

        expect(retryDelays.length).toBe(1);
        expect(retryDelays[0]).toBeGreaterThanOrEqual(36);
        expect(retryDelays[0]).toBeLessThanOrEqual(44);
      });
    });
  });

  describe('Integration: app.callTool with declarative retry shorthand', () => {
    beforeEach(async () => {
      testDataDir = path.join(os.tmpdir(), `mcponce-test-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await fs.mkdir(testDataDir, { recursive: true });

      app = createMcpServer({
        name: 'test-retry-server',
        version: '1.0.0',
        dataDir: testDataDir,
        logging: false
      });
    });

    afterEach(async () => {
      try {
        await app.stop();
      } catch {}
      try {
        await fs.rm(testDataDir, { recursive: true, force: true });
      } catch {}
    });

    it('retries a flaky tool and succeeds with retry count in analytics', async () => {
      let calls = 0;

      app.tool({
        name: 'flaky_shorthand',
        retry: 2, // retry up to 2 times (3 total attempts)
        handler: () => {
          calls++;
          if (calls < 3) {
            throw new Error(`Temporary glitch #${calls}`);
          }
          return { status: 'healthy', attempt: calls };
        }
      });

      const res = await app.callTool('flaky_shorthand');
      expect(res.data).toEqual({ status: 'healthy', attempt: 3 });
      expect(calls).toBe(3);

      const snapshot = app.getAnalytics();
      expect(snapshot.summary.totalInvocations).toBe(1);
      expect(snapshot.summary.successfulInvocations).toBe(1);
      expect(snapshot.summary.totalRetries).toBe(2);

      const metric = snapshot.tools['flaky_shorthand'];
      expect(metric.calls).toBe(1);
      expect(metric.success).toBe(1);
      expect(metric.retries).toBe(2);

      const recent = snapshot.recentInvocations[0];
      expect(recent.retries).toBe(2);
      expect(recent.status).toBe('success');
    });

    it('throws error when max retries are exhausted and records retries in analytics', async () => {
      let calls = 0;

      app.tool({
        name: 'persistently_broken',
        retry: 2,
        handler: () => {
          calls++;
          throw new Error(`Persistent failure #${calls}`);
        }
      });

      await expect(app.callTool('persistently_broken')).rejects.toThrow('Persistent failure #3');
      expect(calls).toBe(3);

      const snapshot = app.getAnalytics();
      expect(snapshot.summary.totalInvocations).toBe(1);
      expect(snapshot.summary.failedInvocations).toBe(1);
      expect(snapshot.summary.totalRetries).toBe(2);

      const metric = snapshot.tools['persistently_broken'];
      expect(metric.calls).toBe(1);
      expect(metric.errors).toBe(1);
      expect(metric.retries).toBe(2);

      const recent = snapshot.recentInvocations[0];
      expect(recent.retries).toBe(2);
      expect(recent.status).toBe('error');
    });

    it('supports detailed ToolRetryConfig with backoff and retryIf', async () => {
      let fatalCalls = 0;
      let retryableCalls = 0;

      app.tool({
        name: 'conditional_retry',
        retry: {
          attempts: 3,
          backoffMs: 10,
          factor: 2,
          retryIf: (err) => err.message.includes('Retryable')
        },
        handler: (input: { mode: string }) => {
          if (input.mode === 'fatal') {
            fatalCalls++;
            throw new Error('FatalDatabaseCrash');
          }
          retryableCalls++;
          if (retryableCalls < 2) {
            throw new Error('RetryableNetworkTimeout');
          }
          return 'ok';
        }
      });

      // 1. Fatal mode: should not retry
      await expect(app.callTool('conditional_retry', { mode: 'fatal' })).rejects.toThrow('FatalDatabaseCrash');
      expect(fatalCalls).toBe(1);

      // 2. Retryable mode: should retry and recover on 2nd attempt
      const res = await app.callTool('conditional_retry', { mode: 'retryable' });
      expect(res.data).toBe('ok');
      expect(retryableCalls).toBe(2);
    });
  });

  describe('Integration: CallOptions per-call override', () => {
    it('allows caller to disable retry via { retry: false }', async () => {
      let calls = 0;

      app.tool({
        name: 'retry_disabled_at_call',
        retry: 3,
        handler: () => {
          calls++;
          throw new Error('Immediate failure');
        }
      });

      await expect(
        app.callTool('retry_disabled_at_call', {}, { retry: false })
      ).rejects.toThrow('Immediate failure');

      expect(calls).toBe(1);
    });

    it('allows caller to enable or increase retry on a tool without default retry', async () => {
      let calls = 0;

      app.tool({
        name: 'no_default_retry',
        handler: () => {
          calls++;
          if (calls < 3) {
            throw new Error('Retry me');
          }
          return 'success';
        }
      });

      const res = await app.callTool('no_default_retry', {}, {
        retry: {
          attempts: 2,
          backoffMs: 10
        }
      });

      expect(res.data).toBe('success');
      expect(calls).toBe(3);
    });
  });

  describe('Integration: Cancellation and timeout during backoff delay', () => {
    it('aborts promptly when caller signal is triggered during retry backoff sleep', async () => {
      const controller = new AbortController();
      let calls = 0;

      app.tool({
        name: 'sleepy_retry',
        retry: {
          attempts: 5,
          backoffMs: 500 // long backoff
        },
        handler: () => {
          calls++;
          throw new Error('Retry needed');
        }
      });

      // Abort after 50ms (during the 500ms backoff sleep of attempt 1)
      setTimeout(() => controller.abort(new Error('User aborted operation')), 50);

      const start = Date.now();
      await expect(
        app.callTool('sleepy_retry', {}, { signal: controller.signal })
      ).rejects.toThrow('User aborted operation');

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(450); // Aborted promptly well before 500ms delay finished
      expect(calls).toBe(1); // Didn't proceed to attempt 2 because sleep was aborted
    });
  });

  describe('Integration: Inter-tool calls with retry', () => {
    it('retries inner tool calls and propagates recovered result to outer tool', async () => {
      let bCalls = 0;

      app.tool({
        name: 'service_b',
        retry: 2,
        handler: () => {
          bCalls++;
          if (bCalls < 2) {
            throw new Error('Service B temporary outage');
          }
          return { data: 'b_data' };
        }
      });

      app.tool({
        name: 'service_a',
        handler: async (_input, _ctx, extra) => {
          const bResult = await extra.callTool('service_b');
          return { a: 'done', b: bResult.data };
        }
      });

      const res = await app.callTool('service_a');
      expect(res.data).toEqual({
        a: 'done',
        b: { data: 'b_data' }
      });
      expect(bCalls).toBe(2);

      const snapshot = app.getAnalytics();
      expect(snapshot.tools['service_b'].retries).toBe(1);
      expect(snapshot.tools['service_b'].success).toBe(1);
    });
  });

  describe('Integration: Remote MCP Client calls over HTTP', () => {
    it('automatically retries remote MCP tool invocations', async () => {
      let calls = 0;

      app.tool({
        name: 'remote_flaky',
        retry: {
          attempts: 2,
          backoffMs: 10
        },
        handler: () => {
          calls++;
          if (calls < 2) {
            throw new Error('Remote connection dropped');
          }
          return { remote: 'ok', calls };
        }
      });

      const startRes = await app.start({ role: 'owner' });
      const baseUrl = `http://${startRes.host}:${startRes.port}`;

      // Call tool via MCP JSON-RPC over HTTP
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'remote_flaky',
            arguments: {}
          }
        })
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      // Handle SSE response format: event: message\ndata: {...}
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

      expect(json.result.text).toContain('remote');
      expect(calls).toBe(2);
    });

    it('supports AGENTS.md retry configuration aliases (maxRetries, initialDelayMs, backoffFactor, retryableErrors)', async () => {
      let attempts = 0;
      app.tool({
        name: 'agents_md_retry_tool',
        inputSchema: {},
        retry: {
          maxRetries: 3,
          initialDelayMs: 10,
          maxDelayMs: 100,
          backoffFactor: 2,
          retryableErrors: (err) => err.message.includes('503')
        },
        handler: () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('503 Service Unavailable');
          }
          return { status: 'success', attempts };
        }
      });

      const res = await app.callTool('agents_md_retry_tool', {});
      expect(res.data).toEqual({ status: 'success', attempts: 3 });
      expect(attempts).toBe(3);
    });

    it('successfully retries tool configured with jitter and respectRetryAfter', async () => {
      let attempts = 0;
      app.tool({
        name: 'jitter_and_retry_after_tool',
        inputSchema: {},
        retry: {
          maxRetries: 3,
          backoffMs: 20,
          jitter: true,
          respectRetryAfter: true
        },
        handler: () => {
          attempts++;
          if (attempts < 2) {
            const err: any = new Error('429 Too Many Requests');
            err.retryAfterMs = 5;
            throw err;
          }
          return { status: 'ok', attempts };
        }
      });

      const res = await app.callTool('jitter_and_retry_after_tool', {});
      expect(res.data).toEqual({ status: 'ok', attempts: 2 });
      expect(attempts).toBe(2);

      const metrics = app.getAnalytics().tools['jitter_and_retry_after_tool'];
      expect(metrics.retries).toBe(1);
      expect(metrics.success).toBe(1);
    });
  });
});
