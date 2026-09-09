import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMcpServer, McpApp } from '../src/index.js';
import { createProgressReporter } from '../src/utils/progress.js';
import { formatCliProgress, parseParametricArgs } from '../src/cli/tool-caller.js';
import type { ToolProgressNotification } from '../src/types.js';

describe('Real-Time Progress Reporting', () => {
  let app: McpApp;

  beforeEach(() => {
    app = createMcpServer({
      name: 'test-progress-server',
      version: '1.0.0',
      port: 0
    });
  });

  afterEach(async () => {
    await app.stop({ force: true });
  });

  describe('createProgressReporter unit tests', () => {
    it('dispatches positional arguments (progress, total, message) to onProgress listener', async () => {
      const reports: ToolProgressNotification[] = [];
      const reporter = createProgressReporter({
        toolName: 'download_file',
        progressToken: 'req-123',
        onProgress: (p) => {
          reports.push(p);
        }
      });

      await reporter(25, 100, 'Downloading chunk 1');
      await reporter(50, 100, 'Downloading chunk 2');

      expect(reports).toHaveLength(2);
      expect(reports[0]).toMatchObject({
        tool: 'download_file',
        progress: 25,
        total: 100,
        message: 'Downloading chunk 1',
        progressToken: 'req-123'
      });
      expect(reports[0].timestamp).toBeDefined();
      expect(reports[1]).toMatchObject({
        tool: 'download_file',
        progress: 50,
        total: 100,
        message: 'Downloading chunk 2'
      });
    });

    it('dispatches object argument { progress, total, message }', async () => {
      const reports: ToolProgressNotification[] = [];
      const reporter = createProgressReporter({
        toolName: 'batch_worker',
        onProgress: (p) => {
          reports.push(p);
        }
      });

      await reporter({ progress: 10, total: 50, message: 'Batch 1 complete' });

      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        tool: 'batch_worker',
        progress: 10,
        total: 50,
        message: 'Batch 1 complete',
        progressToken: undefined
      });
    });

    it('sanitizes non-finite or negative numbers gracefully', async () => {
      const reports: ToolProgressNotification[] = [];
      const reporter = createProgressReporter({
        toolName: 'sanitizer_test',
        onProgress: (p) => {
          reports.push(p);
        }
      });

      await reporter(-5, -10, 'Negative values');
      await reporter(NaN, NaN, 'NaN values');

      expect(reports).toHaveLength(2);
      expect(reports[0].progress).toBe(0);
      expect(reports[0].total).toBeUndefined();
      expect(reports[1].progress).toBe(0);
      expect(reports[1].total).toBeUndefined();
    });

    it('sends MCP progress notification when progressToken and sendMcpNotification are present', async () => {
      const sentNotifications: any[] = [];
      const mockSend = vi.fn().mockImplementation(async (n) => {
        sentNotifications.push(n);
      });

      const reporter = createProgressReporter({
        toolName: 'mcp_streamer',
        progressToken: 42,
        sendMcpNotification: mockSend
      });

      await reporter(3, 10, 'Processing item 3');

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(sentNotifications[0]).toEqual({
        method: 'notifications/progress',
        params: {
          progressToken: 42,
          progress: 3,
          total: 10,
          message: 'Processing item 3'
        }
      });
    });

    it('does not send MCP notification if progressToken is undefined', async () => {
      const mockSend = vi.fn();
      const reporter = createProgressReporter({
        toolName: 'no_token_tool',
        progressToken: undefined,
        sendMcpNotification: mockSend
      });

      await reporter(5, 10);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('catches listener and transport exceptions without throwing', async () => {
      const faultySend = vi.fn().mockRejectedValue(new Error('Transport disconnected'));
      const faultyListener = vi.fn().mockImplementation(() => {
        throw new Error('Listener crashed');
      });

      const mockLogger = { warn: vi.fn(), debug: vi.fn() };
      const reporter = createProgressReporter({
        toolName: 'resilient_tool',
        progressToken: 'tok',
        sendMcpNotification: faultySend,
        onProgress: faultyListener,
        logger: mockLogger as any
      });

      // Must not reject or throw, and covers logger.warn branches
      await expect(reporter({ progress: 1, total: '10' as any, message: 'Test' })).resolves.toBeUndefined();
      expect(faultySend).toHaveBeenCalled();
      expect(faultyListener).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Programmatic Tool Execution (app.callTool with onProgress)', () => {
    it('reports progress via context.reportProgress positional signature', async () => {
      app.tool({
        name: 'job_runner',
        description: 'Executes multi-step job',
        inputSchema: { steps: 'number' },
        handler: async ({ steps }, context) => {
          for (let i = 1; i <= steps; i++) {
            await context.reportProgress?.(i, steps, `Step ${i} done`);
          }
          return { completed: true, totalSteps: steps };
        }
      });

      const progressEvents: ToolProgressNotification[] = [];
      const result = await app.callTool('job_runner', { steps: 3 }, {
        onProgress: (p) => {
          progressEvents.push(p);
        }
      });

      expect(result.data).toEqual({ completed: true, totalSteps: 3 });
      expect(progressEvents).toHaveLength(3);
      expect(progressEvents[0]).toMatchObject({
        tool: 'job_runner',
        progress: 1,
        total: 3,
        message: 'Step 1 done'
      });
      expect(progressEvents[2]).toMatchObject({
        tool: 'job_runner',
        progress: 3,
        total: 3,
        message: 'Step 3 done'
      });
    });

    it('reports progress via extra.reportProgress object signature', async () => {
      app.tool({
        name: 'extra_reporter',
        description: 'Reports progress via extra',
        handler: async (_args, _context, extra) => {
          await extra.reportProgress({ progress: 50, total: 100, message: 'Halfway' });
          await extra.reportProgress({ progress: 100, total: 100, message: 'Done' });
          return 'ok';
        }
      });

      const events: ToolProgressNotification[] = [];
      await app.callTool('extra_reporter', {}, {
        onProgress: (p) => {
          events.push(p);
        }
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        tool: 'extra_reporter',
        progress: 50,
        total: 100,
        message: 'Halfway'
      });
      expect(events[1]).toMatchObject({
        tool: 'extra_reporter',
        progress: 100,
        total: 100,
        message: 'Done'
      });
    });

    it('allows tools to execute safely when onProgress is not provided', async () => {
      app.tool({
        name: 'silent_progress_tool',
        description: 'Runs without listener',
        handler: async (_args, context) => {
          await context.reportProgress?.(1, 10, 'Step 1');
          return { success: true };
        }
      });

      const result = await app.callTool('silent_progress_tool');
      expect(result.data).toEqual({ success: true });
    });

    it('forwards progress during inter-tool invocations', async () => {
      app.tool({
        name: 'sub_task',
        description: 'Performs subtask',
        handler: async (_args, context) => {
          await context.reportProgress?.(1, 2, 'Subtask step 1');
          await context.reportProgress?.(2, 2, 'Subtask step 2');
          return 'subtask complete';
        }
      });

      app.tool({
        name: 'master_task',
        description: 'Coordinates subtask',
        handler: async (_args, context) => {
          await context.reportProgress?.(1, 10, 'Master starting');
          // Call sub_task and forward its progress
          await context.callTool('sub_task', {}, {
            onProgress: async (subProgress) => {
              await context.reportProgress?.({
                progress: 5,
                total: 10,
                message: `Master forwarding: ${subProgress.message}`
              });
            }
          });
          await context.reportProgress?.(10, 10, 'Master done');
          return 'all complete';
        }
      });

      const events: ToolProgressNotification[] = [];
      const result = await app.callTool('master_task', {}, {
        onProgress: (p) => {
          events.push(p);
        }
      });

      expect(result.data).toBe('all complete');
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events[0].message).toBe('Master starting');
      expect(events.some((e) => e.message?.includes('Subtask step 1') || e.message?.includes('Master forwarding'))).toBe(true);
      expect(events[events.length - 1].message).toBe('Master done');
    });
  });

  describe('CLI Progress Formatting & Flags', () => {
    it('formats CLI progress message with percentage and status', () => {
      const formatted = formatCliProgress({
        tool: 'indexer',
        progress: 25,
        total: 100,
        message: 'Parsing AST'
      });

      expect(formatted).toContain('indexer');
      expect(formatted).toContain('25/100');
      expect(formatted).toContain('(25%)');
      expect(formatted).toContain('Parsing AST');
    });

    it('formats CLI progress without percentage when total is missing', () => {
      const formatted = formatCliProgress({
        tool: 'scanner',
        progress: 42,
        message: 'Found item'
      });

      expect(formatted).toContain('scanner');
      expect(formatted).toContain('42');
      expect(formatted).not.toContain('%');
      expect(formatted).toContain('Found item');
    });

    it('parses --no-progress flag in CLI args', () => {
      const parsed = parseParametricArgs(['--no-progress', '--key', 'value']);
      expect(parsed.noProgress).toBe(true);
      expect(parsed.params.key).toBe('value');
    });
  });

  describe('Integration: Remote MCP Client calls over HTTP SSE stream', () => {
    it('transmits notifications/progress events to MCP client over HTTP SSE', async () => {
      app.tool({
        name: 'long_job',
        description: 'Simulates work with progress updates',
        inputSchema: { count: 'number' },
        handler: async ({ count }, context) => {
          for (let i = 1; i <= count; i++) {
            await context.reportProgress?.(i, count, `Progress item ${i}`);
          }
          return { done: true, count };
        }
      });

      const startRes = await app.start({ role: 'owner' });
      const baseUrl = `http://${startRes.host}:${startRes.port}`;

      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test-call-1',
          method: 'tools/call',
          params: {
            name: 'long_job',
            arguments: { count: 3 },
            _meta: {
              progressToken: 'token-xyz-100'
            }
          }
        })
      });

      expect(response.status).toBe(200);
      const text = await response.text();

      // Look for notifications/progress events in the SSE stream
      const lines = text.split('\n');
      const progressNotifications: any[] = [];
      let finalResult: any = null;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.method === 'notifications/progress') {
              progressNotifications.push(parsed);
            } else if (parsed.id === 'test-call-1') {
              finalResult = parsed;
            }
          } catch {}
        }
      }

      // If text is standard JSON instead of SSE
      if (!finalResult && !progressNotifications.length) {
        try {
          finalResult = JSON.parse(text);
        } catch {}
      }

      expect(progressNotifications.length).toBe(3);
      expect(progressNotifications[0].params).toMatchObject({
        progressToken: 'token-xyz-100',
        progress: 1,
        total: 3,
        message: 'Progress item 1'
      });
      expect(progressNotifications[2].params).toMatchObject({
        progressToken: 'token-xyz-100',
        progress: 3,
        total: 3,
        message: 'Progress item 3'
      });

      expect(finalResult).toBeDefined();
      expect(finalResult.result).toBeDefined();
      expect(finalResult.result.isError).toBeFalsy();
      expect(finalResult.result.text).toContain('"done":true');
    });
  });
});
