import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMcpServer, McpApp } from '../src/index.js';
import { matchesFilter, composeMiddleware, MiddlewareManager } from '../src/utils/middleware.js';

describe('Lightweight Middleware / Interceptors (app.use)', () => {
  let app: McpApp;

  beforeEach(() => {
    app = createMcpServer({
      name: 'test-middleware-server',
      version: '1.0.0',
      port: 0
    });
  });

  afterEach(async () => {
    await app.stop({ force: true });
  });

  describe('matchesFilter utility unit tests', () => {
    it('matches wildcard asterisks and exact strings correctly', () => {
      expect(matchesFilter(undefined, 'any_tool')).toBe(true);
      expect(matchesFilter('*', 'any_tool')).toBe(true);
      expect(matchesFilter('exact_name', 'exact_name')).toBe(true);
      expect(matchesFilter('exact_name', 'other_name')).toBe(false);
      expect(matchesFilter('admin_*', 'admin_users')).toBe(true);
      expect(matchesFilter('admin_*', 'admin_roles')).toBe(true);
      expect(matchesFilter('admin_*', 'user_admin')).toBe(false);
      expect(matchesFilter('*_read', 'user_read')).toBe(true);
      expect(matchesFilter('*_read', 'user_write')).toBe(false);
    });

    it('matches regular expressions and arrays of filters', () => {
      expect(matchesFilter(/^audit_/, 'audit_log')).toBe(true);
      expect(matchesFilter(/^audit_/, 'user_log')).toBe(false);
      expect(matchesFilter(['calc_*', 'admin_*'], 'calc_add')).toBe(true);
      expect(matchesFilter(['calc_*', 'admin_*'], 'admin_del')).toBe(true);
      expect(matchesFilter(['calc_*', 'admin_*'], 'other_tool')).toBe(false);
    });
  });

  describe('composeMiddleware unit tests', () => {
    it('executes middlewares in onion order (before -> handler -> after)', async () => {
      const order: string[] = [];

      const m1 = async (_ctx: any, next: any) => {
        order.push('m1_before');
        const res = await next();
        order.push('m1_after');
        return res;
      };

      const m2 = async (_ctx: any, next: any) => {
        order.push('m2_before');
        const res = await next();
        order.push('m2_after');
        return res;
      };

      const finalHandler = async (_ctx: any) => {
        order.push('handler');
        return 'handler_result';
      };

      const pipeline = composeMiddleware([m1, m2], finalHandler);
      const result = await pipeline({ tool: 'test', args: {}, context: {}, extra: {} as any, callStack: [] });

      expect(result).toBe('handler_result');
      expect(order).toEqual(['m1_before', 'm2_before', 'handler', 'm2_after', 'm1_after']);
    });

    it('rejects if next() is called multiple times in a single middleware', async () => {
      const badMiddleware = async (_ctx: any, next: any) => {
        await next();
        return await next(); // Invalid second call
      };

      const pipeline = composeMiddleware([badMiddleware], async () => 'ok');
      await expect(
        pipeline({ tool: 'test', args: {}, context: {}, extra: {} as any, callStack: [] })
      ).rejects.toThrow('next() called multiple times');
    });
  });

  describe('McpApp.use() Integration with app.callTool', () => {
    it('executes global middleware and supports method chaining', async () => {
      const trace: string[] = [];

      const chain = app
        .use(async (ctx, next) => {
          trace.push(`global1_start:${ctx.tool}`);
          const res = await next();
          trace.push(`global1_end:${ctx.tool}`);
          return res;
        })
        .use(async (ctx, next) => {
          trace.push(`global2_start:${ctx.tool}`);
          const res = await next();
          trace.push(`global2_end:${ctx.tool}`);
          return res;
        })
        .tool({
          name: 'compute',
          inputSchema: { val: 'number' },
          handler: ({ val }) => {
            trace.push(`handler:${val}`);
            return val * 2;
          }
        });

      expect(chain).toBe(app);

      const result = await app.callTool('compute', { val: 5 });
      expect(result.data).toBe(10);
      expect(trace).toEqual([
        'global1_start:compute',
        'global2_start:compute',
        'handler:5',
        'global2_end:compute',
        'global1_end:compute'
      ]);
    });

    it('allows middleware to mutate arguments before handler executes', async () => {
      app.use(async (ctx, next) => {
        // Enforce default and trim string
        ctx.args.text = (ctx.args.text || '').trim().toLowerCase();
        ctx.args.injectedParam = 'injected_value';
        return next();
      });

      app.tool({
        name: 'echo_clean',
        inputSchema: { text: 'string' },
        handler: (args) => args
      });

      const result = await app.callTool('echo_clean', { text: '  HELLO WORLD  ' });
      expect(result.data).toEqual({
        text: 'hello world',
        injectedParam: 'injected_value'
      });
    });

    it('allows middleware to enrich the shared context', async () => {
      app.use(async (ctx, next) => {
        (ctx.context as any).currentUser = { id: 101, username: 'alice' };
        return next();
      });

      app.tool({
        name: 'whoami',
        handler: (_args, context: any) => {
          return { user: context.currentUser };
        }
      });

      const result = await app.callTool('whoami');
      expect(result.data).toEqual({
        user: { id: 101, username: 'alice' }
      });
    });

    it('allows middleware to short-circuit execution without calling handler', async () => {
      const handlerSpy = vi.fn();

      app.use(async (ctx, next) => {
        if (ctx.args.cachedResponse) {
          return { fromMiddleware: true, value: ctx.args.cachedResponse };
        }
        return next();
      });

      app.tool({
        name: 'heavy_op',
        inputSchema: { cachedResponse: { type: 'string', required: false } },
        handler: handlerSpy
      });

      const result = await app.callTool('heavy_op', { cachedResponse: 'quick_hit' });
      expect(result.data).toEqual({ fromMiddleware: true, value: 'quick_hit' });
      expect(handlerSpy).not.toHaveBeenCalled();
    });

    it('allows middleware to reject execution with unauthorized error', async () => {
      app.use(async (ctx, next) => {
        if (!ctx.args.apiKey || ctx.args.apiKey !== 'secret-key') {
          throw new Error('Unauthorized: Valid apiKey required');
        }
        return next();
      });

      app.tool({
        name: 'secure_vault',
        inputSchema: { apiKey: { type: 'string', required: false } },
        handler: () => 'vault_data'
      });

      await expect(app.callTool('secure_vault', {})).rejects.toThrow('Unauthorized: Valid apiKey required');

      // Now with valid key:
      const okResult = await app.callTool('secure_vault', { apiKey: 'secret-key' });
      expect(okResult.data).toBe('vault_data');
    });

    it('allows middleware to catch errors and return fallback responses', async () => {
      app.use(async (_ctx, next) => {
        try {
          return await next();
        } catch (err: any) {
          return {
            fallback: true,
            originalError: err.message
          };
        }
      });

      app.tool({
        name: 'unstable_tool',
        handler: () => {
          throw new Error('Database connection failed');
        }
      });

      const result = await app.callTool('unstable_tool', {}, { throwOnError: false });
      expect(result.data).toEqual({
        fallback: true,
        originalError: 'Database connection failed'
      });
    });

    it('allows middleware to transform or wrap handler output', async () => {
      app.use(async (_ctx, next) => {
        const result = await next();
        return {
          wrapped: true,
          payload: result,
          processedAt: '2026-09-09'
        };
      });

      app.tool({
        name: 'raw_data',
        handler: () => ({ number: 42 })
      });

      const res = await app.callTool('raw_data');
      expect(res.data).toEqual({
        wrapped: true,
        payload: { number: 42 },
        processedAt: '2026-09-09'
      });
    });
  });

  describe('Pattern-Based & Tool-Specific Middleware', () => {
    it('applies pattern-filtered middleware to matching tools only', async () => {
      const adminLogs: string[] = [];
      const userLogs: string[] = [];

      app.use('admin_*', async (ctx, next) => {
        adminLogs.push(ctx.tool);
        return next();
      });

      app.use(['user_*', 'member_*'], async (ctx, next) => {
        userLogs.push(ctx.tool);
        return next();
      });

      app.tool({ name: 'admin_delete', handler: () => 'deleted' });
      app.tool({ name: 'admin_create', handler: () => 'created' });
      app.tool({ name: 'user_view', handler: () => 'viewed' });
      app.tool({ name: 'other_task', handler: () => 'done' });

      await app.callTool('admin_delete');
      await app.callTool('admin_create');
      await app.callTool('user_view');
      await app.callTool('other_task');

      expect(adminLogs).toEqual(['admin_delete', 'admin_create']);
      expect(userLogs).toEqual(['user_view']);
    });

    it('executes tool-specific middleware defined in ToolDefinition', async () => {
      const logs: string[] = [];

      const toolMiddleware1 = async (ctx: any, next: any) => {
        logs.push(`tool_m1_before:${ctx.tool}`);
        const res = await next();
        logs.push(`tool_m1_after:${ctx.tool}`);
        return res;
      };

      app.use(async (ctx, next) => {
        logs.push(`global_before:${ctx.tool}`);
        const res = await next();
        logs.push(`global_after:${ctx.tool}`);
        return res;
      });

      app.tool({
        name: 'dedicated_tool',
        middleware: [toolMiddleware1],
        handler: () => {
          logs.push('handler_run');
          return 'ok';
        }
      });

      const res = await app.callTool('dedicated_tool');
      expect(res.data).toBe('ok');
      expect(logs).toEqual([
        'global_before:dedicated_tool',
        'tool_m1_before:dedicated_tool',
        'handler_run',
        'tool_m1_after:dedicated_tool',
        'global_after:dedicated_tool'
      ]);
    });

    it('supports initial middlewares configured in createMcpServer constructor', async () => {
      const initialLogs: string[] = [];

      const customApp = createMcpServer({
        name: 'initial-middleware-server',
        middleware: [
          async (ctx, next) => {
            initialLogs.push(`init1:${ctx.tool}`);
            return next();
          },
          {
            filter: 'filtered_*',
            handler: async (ctx, next) => {
              initialLogs.push(`init2_filtered:${ctx.tool}`);
              return next();
            }
          }
        ]
      });

      customApp.tool({ name: 'filtered_action', handler: () => 'ok' });
      customApp.tool({ name: 'plain_action', handler: () => 'ok' });

      await customApp.callTool('filtered_action');
      await customApp.callTool('plain_action');

      expect(initialLogs).toEqual([
        'init1:filtered_action',
        'init2_filtered:filtered_action',
        'init1:plain_action'
      ]);

      await customApp.stop({ force: true });
    });
  });

  describe('Integration: Remote MCP Client calls over HTTP /mcp', () => {
    it('executes middleware pipeline when invoked remotely over HTTP /mcp', async () => {
      app.use(async (ctx, next) => {
        ctx.args.injectedByMiddleware = true;
        const res = await next();
        return { ...res, enrichedByMiddleware: true };
      });

      app.tool({
        name: 'remote_tool',
        handler: (args) => {
          return { receivedArgs: args };
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
          id: 'call-remote-1',
          method: 'tools/call',
          params: {
            name: 'remote_tool',
            arguments: { initialParam: 123 }
          }
        })
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);

      expect(json.result).toBeDefined();
      expect(json.result.isError).toBeFalsy();
      expect(json.result.text).toContain('"injectedByMiddleware":true');
      expect(json.result.text).toContain('"enrichedByMiddleware":true');
    });
  });

  describe('Middleware Edge Cases & Manager Unit Tests', () => {
    it('handles invalid filter types and empty elements in composeMiddleware', async () => {
      expect(matchesFilter(12345 as any, 'some_tool')).toBe(false);

      // compose with undefined middleware item
      const fn = composeMiddleware([undefined as any], async () => 'ok');
      expect(await fn({} as any)).toBeUndefined();

      // compose catching synchronous error in middleware
      const syncErrFn = composeMiddleware([() => { throw new Error('sync failure'); }], async () => 'ok');
      await expect(syncErrFn({} as any)).rejects.toThrow('sync failure');
    });

    it('tests MiddlewareManager constructor variations, count, clear, and error cases', () => {
      const handler1 = async (_ctx: any, next: any) => next();
      const handler2 = async (_ctx: any, next: any) => next();

      // Initial middlewares with function and object without filter
      const mm = new MiddlewareManager([
        handler1,
        { handler: handler2 },
        { filter: 'custom_*', handler: handler1 }
      ]);

      expect(mm.count()).toBe(3);

      expect(() => mm.use('filter', null as any)).toThrow('Middleware handler must be a function');

      mm.clear();
      expect(mm.count()).toBe(0);
    });
  });
});
