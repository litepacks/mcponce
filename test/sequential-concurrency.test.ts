import { describe, it, expect } from 'vitest';
import { createMcpServer, ConcurrencyQueue } from '../src/index.js';
import { QueueManager } from '../src/utils/queue.js';

describe('Sequential & Concurrency Queue Control', () => {
  describe('ConcurrencyQueue unit tests', () => {
    it('limits concurrent tasks to maxConcurrency (FIFO order)', async () => {
      const queue = new ConcurrencyQueue(1);
      const executionOrder: number[] = [];
      let maxActiveObserved = 0;

      const runTask = async (id: number, delayMs: number) => {
        return queue.run(async () => {
          maxActiveObserved = Math.max(maxActiveObserved, queue.active);
          executionOrder.push(id);
          await new Promise((r) => setTimeout(r, delayMs));
        });
      };

      await Promise.all([
        runTask(1, 40),
        runTask(2, 30),
        runTask(3, 10)
      ]);

      expect(maxActiveObserved).toBe(1);
      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('handles cancellation while waiting in queue without blocking subsequent tasks', async () => {
      const queue = new ConcurrencyQueue(1);
      const controller2 = new AbortController();
      const events: string[] = [];

      // Task 1 runs and holds the queue for 60ms
      const p1 = queue.run(async () => {
        events.push('task1-start');
        await new Promise((r) => setTimeout(r, 60));
        events.push('task1-end');
      });

      // Task 2 waits in queue and will be cancelled at 20ms
      const p2 = queue.run(async () => {
        events.push('task2-start');
      }, controller2.signal);
      const p2Expectation = expect(p2).rejects.toThrow('Task 2 aborted');

      // Task 3 waits in queue behind Task 2
      const p3 = queue.run(async () => {
        events.push('task3-start');
      });

      // Cancel Task 2 while Task 1 is still running
      setTimeout(() => {
        controller2.abort(new Error('Task 2 aborted'));
      }, 20);

      await p1;
      await p2Expectation;
      await p3;

      expect(events).toEqual(['task1-start', 'task1-end', 'task3-start']);
    });

    it('validates constructor arguments and immediate signal cancellation', async () => {
      expect(() => new ConcurrencyQueue(0)).toThrow('maxConcurrency must be at least 1');

      const queue = new ConcurrencyQueue(1);
      const preAborted = AbortSignal.abort(new Error('Pre-aborted'));
      await expect(queue.acquire(preAborted)).rejects.toThrow('Pre-aborted');

      const abortedWithoutReason = AbortSignal.abort();
      await expect(queue.acquire(abortedWithoutReason)).rejects.toThrow();
    });

    it('skips already aborted items during release loop', async () => {
      const q = new ConcurrencyQueue(1);
      const release1 = await q.acquire();
      const ctrl = new AbortController();
      // Push directly or acquire
      (q as any).queue.push({
        resolve: () => {},
        reject: () => {},
        signal: ctrl.signal
      });
      ctrl.abort();
      release1();
      expect(q.active).toBe(0);
    });

    it('tests QueueManager getQueue, getStats, and clear', () => {
      const qm = new QueueManager();
      const q1 = qm.getQueue('db', 2);
      expect(q1.maxConcurrency).toBe(2);
      expect(qm.getQueue('db')).toBe(q1);

      const stats = qm.getStats();
      expect(stats.db).toEqual({ active: 0, pending: 0, maxConcurrency: 2 });

      qm.clear();
      expect(qm.getStats()).toEqual({});
    });
  });

  describe('Tool-level sequential: true', () => {
    it('executes invocations of a sequential tool one-by-one (concurrency: 1)', async () => {
      const app = createMcpServer('test-tool-sequential');
      let activeJobs = 0;
      let maxActiveObserved = 0;
      const order: number[] = [];

      app.tool({
        name: 'sequential_job',
        sequential: true,
        inputSchema: { id: 'number', delay: 'number' },
        handler: async ({ id, delay }) => {
          activeJobs++;
          maxActiveObserved = Math.max(maxActiveObserved, activeJobs);
          order.push(id);
          await new Promise((r) => setTimeout(r, delay));
          activeJobs--;
          return { id, completed: true };
        }
      });

      // Fire 4 calls concurrently
      const promises = [
        app.callTool('sequential_job', { id: 1, delay: 50 }),
        app.callTool('sequential_job', { id: 2, delay: 30 }),
        app.callTool('sequential_job', { id: 3, delay: 20 }),
        app.callTool('sequential_job', { id: 4, delay: 10 })
      ];

      const results = await Promise.all(promises);

      expect(maxActiveObserved).toBe(1);
      expect(order).toEqual([1, 2, 3, 4]);
      expect(results.map((r) => r.data.id)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('Named Mutex Queue across different tools', () => {
    it('serializes different tools sharing the same named mutex (e.g. sequential: "browser")', async () => {
      const app = createMcpServer('test-named-mutex');
      let activeMutexOperations = 0;
      let maxMutexObserved = 0;
      const log: string[] = [];

      app.tool({
        name: 'browser_navigate',
        sequential: 'browser',
        handler: async () => {
          activeMutexOperations++;
          maxMutexObserved = Math.max(maxMutexObserved, activeMutexOperations);
          log.push('navigate-start');
          await new Promise((r) => setTimeout(r, 40));
          log.push('navigate-end');
          activeMutexOperations--;
          return 'navigated';
        }
      });

      app.tool({
        name: 'browser_click',
        sequential: 'browser',
        handler: async () => {
          activeMutexOperations++;
          maxMutexObserved = Math.max(maxMutexObserved, activeMutexOperations);
          log.push('click-start');
          await new Promise((r) => setTimeout(r, 30));
          log.push('click-end');
          activeMutexOperations--;
          return 'clicked';
        }
      });

      app.tool({
        name: 'unrelated_math',
        // Not sequential - can run in parallel
        handler: async () => {
          log.push('math-done');
          return 'math';
        }
      });

      // Fire all three concurrently
      await Promise.all([
        app.callTool('browser_navigate'),
        app.callTool('browser_click'),
        app.callTool('unrelated_math')
      ]);

      // Navigate and click must NEVER overlap
      expect(maxMutexObserved).toBe(1);
      expect(log.indexOf('navigate-end')).toBeLessThan(log.indexOf('click-start'));
      expect(log).toContain('math-done');
    });
  });

  describe('Server-level sequential: true', () => {
    it('serializes all tool calls across the entire server when server is configured with sequential: true', async () => {
      const app = createMcpServer({
        name: 'test-server-sequential',
        sequential: true
      });

      expect(app.config.sequential).toBe(true);
      expect(app.config.maxConcurrency).toBe(1);

      let runningCount = 0;
      let maxRunning = 0;
      const history: string[] = [];

      app.tool({
        name: 'tool_alpha',
        handler: async () => {
          runningCount++;
          maxRunning = Math.max(maxRunning, runningCount);
          history.push('alpha-start');
          await new Promise((r) => setTimeout(r, 40));
          history.push('alpha-end');
          runningCount--;
          return 'alpha';
        }
      });

      app.tool({
        name: 'tool_beta',
        handler: async () => {
          runningCount++;
          maxRunning = Math.max(maxRunning, runningCount);
          history.push('beta-start');
          await new Promise((r) => setTimeout(r, 30));
          history.push('beta-end');
          runningCount--;
          return 'beta';
        }
      });

      await Promise.all([
        app.callTool('tool_alpha'),
        app.callTool('tool_beta')
      ]);

      expect(maxRunning).toBe(1);
      expect(history.indexOf('alpha-end')).toBeLessThan(history.indexOf('beta-start'));
    });

    it('safely handles re-entrant inter-tool calls without self-deadlocking on global queue', async () => {
      const app = createMcpServer({
        name: 'test-reentrant-seq',
        sequential: true
      });

      app.tool({
        name: 'child_tool',
        inputSchema: { val: 'number' },
        handler: async ({ val }) => val * 2
      });

      app.tool({
        name: 'parent_tool',
        inputSchema: { val: 'number' },
        handler: async ({ val }, { callTool }) => {
          // Parent already holds the server queue; child call must not deadlock!
          const res = await callTool('child_tool', { val });
          return res.data + 10;
        }
      });

      const result = await app.callTool('parent_tool', { val: 5 });
      expect(result.data).toBe(20);
    });
  });

  describe('Tool-level maxConcurrency: 2', () => {
    it('allows up to 2 concurrent executions but queues the third and fourth', async () => {
      const app = createMcpServer('test-concurrency-two');
      let active = 0;
      let maxActive = 0;

      app.tool({
        name: 'two_at_a_time',
        maxConcurrency: 2,
        handler: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 40));
          active--;
          return 'done';
        }
      });

      await Promise.all([
        app.callTool('two_at_a_time'),
        app.callTool('two_at_a_time'),
        app.callTool('two_at_a_time'),
        app.callTool('two_at_a_time')
      ]);

      expect(maxActive).toBe(2);
    });
  });

  describe('Sequential Tool Execution over HTTP MCP Protocol', () => {
    it('serializes requests sent by remote MCP clients over HTTP', async () => {
      const app = createMcpServer({
        name: 'test-http-sequential',
        port: 0
      });

      let activeCount = 0;
      let maxObserved = 0;
      const history: number[] = [];

      app.tool({
        name: 'slow_serial',
        sequential: true,
        inputSchema: { id: 'number' },
        handler: async ({ id }) => {
          activeCount++;
          maxObserved = Math.max(maxObserved, activeCount);
          history.push(id);
          await new Promise((r) => setTimeout(r, 50));
          activeCount--;
          return { id, ok: true };
        }
      });

      const { host, port } = await app.start();
      const baseUrl = `http://${host}:${port}`;

      try {
        // Initialize an MCP session
        const initRes = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test-client', version: '1.0.0' }
            }
          })
        });

        const sessionId = initRes.headers.get('mcp-session-id')!;

        const callRemote = async (id: number) => {
          const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream',
              'mcp-session-id': sessionId
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: id + 10,
              method: 'tools/call',
              params: {
                name: 'slow_serial',
                arguments: { id }
              }
            })
          });
          const text = await res.text();
          const match = text.match(/data:\s*(\{.*\})/);
          return match ? JSON.parse(match[1]) : JSON.parse(text);
        };

        // Fire 3 remote HTTP tool calls simultaneously
        const [r1, r2, r3] = await Promise.all([
          callRemote(1),
          callRemote(2),
          callRemote(3)
        ]);

        expect(maxObserved).toBe(1);
        expect(history).toEqual([1, 2, 3]);
        expect(r1.result).toBeDefined();
        expect(r2.result).toBeDefined();
        expect(r3.result).toBeDefined();
      } finally {
        await app.stop();
      }
    });

    it('ConcurrencyQueue throws if maxConcurrency is less than 1', () => {
      expect(() => new ConcurrencyQueue(0)).toThrow('maxConcurrency must be at least 1');
      expect(() => new ConcurrencyQueue(-5)).toThrow('maxConcurrency must be at least 1');
    });

    it('release callback is idempotent and does not corrupt active counter on double release', async () => {
      const queue = new ConcurrencyQueue(2);
      const release1 = await queue.acquire();
      expect(queue.active).toBe(1);

      release1();
      expect(queue.active).toBe(0);

      // Re-invoking release1 should be a safe no-op
      release1();
      expect(queue.active).toBe(0);
    });

    it('QueueManager getStats provides accurate metrics across multiple named queues', async () => {
      const qm = new QueueManager();
      const dbQueue = qm.getQueue('database', 1);
      const apiQueue = qm.getQueue('api-scraper', 3);

      const releaseDb = await dbQueue.acquire();
      const releaseApi1 = await apiQueue.acquire();
      const releaseApi2 = await apiQueue.acquire();

      const stats = qm.getStats();
      expect(stats.database).toEqual({ active: 1, pending: 0, maxConcurrency: 1 });
      expect(stats['api-scraper']).toEqual({ active: 2, pending: 0, maxConcurrency: 3 });

      releaseDb();
      releaseApi1();
      releaseApi2();

      const afterStats = qm.getStats();
      expect(afterStats.database.active).toBe(0);
      expect(afterStats['api-scraper'].active).toBe(0);
    });

    it('QueueManager clear resets all tracked queues', () => {
      const qm = new QueueManager();
      qm.getQueue('q1', 1);
      qm.getQueue('q2', 2);
      expect(Object.keys(qm.getStats()).length).toBe(2);

      qm.clear();
      expect(qm.getStats()).toEqual({});
    });

    it('multi-slot ConcurrencyQueue accurately caps concurrent tasks at maxConcurrency (e.g. 3)', async () => {
      const queue = new ConcurrencyQueue(3);
      let activeCounter = 0;
      let peakConcurrency = 0;

      const runWorker = async (delayMs: number) => {
        return queue.run(async () => {
          activeCounter++;
          peakConcurrency = Math.max(peakConcurrency, activeCounter);
          await new Promise((r) => setTimeout(r, delayMs));
          activeCounter--;
        });
      };

      await Promise.all([
        runWorker(40),
        runWorker(40),
        runWorker(40),
        runWorker(30),
        runWorker(30),
        runWorker(20)
      ]);

      expect(peakConcurrency).toBe(3);
      expect(queue.active).toBe(0);
      expect(queue.pending).toBe(0);
    });
  });
});
