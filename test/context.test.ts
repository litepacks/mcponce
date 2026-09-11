import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMcpServer } from '../src/index.js';

describe('shared application context', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('initializes context exactly once and injects into handlers', async () => {
    let initCalls = 0;

    const app = createMcpServer({
      name: 'ctx-app',
      dataDir: testDir,
      async context() {
        initCalls++;
        return {
          db: { count: 42 }
        };
      }
    });

    let toolContextResult: any = null;

    app.tool({
      name: 'get-count',
      description: 'Get count from db',
      async handler(_input, ctx) {
        toolContextResult = ctx.db.count;
        return {
          content: [{ type: 'text', text: `Count: ${ctx.db.count}` }]
        };
      }
    });

    const startResult = await app.start();
    expect(startResult.reused).toBe(false);
    expect(initCalls).toBe(1);

    // Call tool directly through registry
    const tool = app.toolRegistry.get('get-count');
    expect(tool).toBeDefined();
    await tool?.handler({}, app.contextManager.getContext());

    expect(toolContextResult).toBe(42);
    expect(initCalls).toBe(1); // Still 1!

    await app.stop();
  });

  it('aborts startup and logs failure if context initialization throws', async () => {
    const app = createMcpServer({
      name: 'failing-ctx-app',
      dataDir: testDir,
      async context() {
        throw new Error('Database connection failed');
      }
    });

    await expect(app.start()).rejects.toThrow('Database connection failed');

    // Verify runtime.json was NOT left behind in a misleading healthy state
    const runtimePath = path.join(testDir, 'runtime.json');
    expect(fs.existsSync(runtimePath)).toBe(false);

    await app.stop();
  });

  it('tests ContextManager class directly for 100% branch coverage', async () => {
    const { ContextManager } = await import('../src/server/context.js');

    // 1. Without factory
    const noFactory = new ContextManager();
    expect(noFactory.isInitialized()).toBe(false);
    const emptyCtx = await noFactory.initialize();
    expect(emptyCtx).toEqual({});
    expect(noFactory.isInitialized()).toBe(true);

    // 2. getContext before initialization throws error when factory exists
    const withFactory = new ContextManager(async () => ({ user: 'admin' }));
    expect(() => withFactory.getContext()).toThrow('Context requested before initialization was completed');

    // 3. Concurrent initialization shares same initializingPromise
    const [ctx1, ctx2] = await Promise.all([withFactory.initialize(), withFactory.initialize()]);
    expect(ctx1).toBe(ctx2);
    expect(ctx1).toEqual({ user: 'admin' });

    // 4. Repeated initialize() returns cachedContext immediately
    const cached = await withFactory.initialize();
    expect(cached).toBe(ctx1);
    expect(withFactory.getContext()).toBe(ctx1);
  });

  it('handles slow/delayed async context factory without redundant execution', async () => {
    let factoryInvocations = 0;
    const { ContextManager } = await import('../src/server/context.js');

    const manager = new ContextManager(async () => {
      factoryInvocations++;
      await new Promise((r) => setTimeout(r, 50));
      return { connectedAt: Date.now() };
    });

    const results = await Promise.all([
      manager.initialize(),
      manager.initialize(),
      manager.initialize(),
      manager.initialize()
    ]);

    expect(factoryInvocations).toBe(1);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(results[2]).toBe(results[3]);
    expect(manager.isInitialized()).toBe(true);
  });

  it('resets initializingPromise after failure allowing subsequent retry', async () => {
    const { ContextManager } = await import('../src/server/context.js');
    let attempts = 0;

    const manager = new ContextManager(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Transient connection outage');
      }
      return { healthy: true, attempt: attempts };
    });

    // First attempt fails
    await expect(manager.initialize()).rejects.toThrow('Transient connection outage');
    expect(manager.isInitialized()).toBe(false);

    // Second attempt recovers and succeeds
    const ctx = await manager.initialize();
    expect(ctx).toEqual({ healthy: true, attempt: 2 });
    expect(manager.isInitialized()).toBe(true);
    expect(manager.getContext()).toEqual({ healthy: true, attempt: 2 });
  });

  it('supports shared state mutation across distinct tool handlers', async () => {
    interface StateContext {
      state: {
        store: Record<string, string>;
        counter: number;
      };
    }

    const app = createMcpServer<StateContext>({
      name: 'mutation-app',
      dataDir: testDir,
      async context() {
        return {
          state: {
            store: {},
            counter: 0
          }
        };
      }
    });

    app.tool({
      name: 'set_value',
      inputSchema: { key: 'string', value: 'string' },
      async handler({ key, value }, ctx) {
        ctx.state.store[key] = value;
        ctx.state.counter++;
        return { stored: true, count: ctx.state.counter };
      }
    });

    app.tool({
      name: 'get_value',
      inputSchema: { key: 'string' },
      async handler({ key }, ctx) {
        return { value: ctx.state.store[key] ?? null, totalUpdates: ctx.state.counter };
      }
    });

    await app.start();

    const setResult = await app.callTool('set_value', { key: 'session_token', value: 'xyz123' });
    expect(setResult.data).toEqual({ stored: true, count: 1 });

    const getResult = await app.callTool('get_value', { key: 'session_token' });
    expect(getResult.data).toEqual({ value: 'xyz123', totalUpdates: 1 });

    await app.stop();
  });

  it('injects both user context and tool extras (signal, callTool, reportProgress) to handlers', async () => {
    const app = createMcpServer({
      name: 'capability-injection-app',
      dataDir: testDir,
      context: () => ({ envName: 'staging' })
    });

    let inspectedContext: any = null;
    let hasSignal = false;
    let hasCallTool = false;
    let hasReportProgress = false;

    app.tool({
      name: 'inspect_capabilities',
      async handler(_args, ctx, extra) {
        inspectedContext = ctx;
        hasSignal = Boolean(ctx?.signal || extra?.signal);
        hasCallTool = typeof (ctx?.callTool || extra?.callTool) === 'function';
        hasReportProgress = typeof (ctx?.reportProgress || extra?.reportProgress) === 'function';
        return 'inspected';
      }
    });

    await app.start();
    const res = await app.callTool('inspect_capabilities', {});
    expect(res.data).toBe('inspected');
    expect(inspectedContext.envName).toBe('staging');
    expect(hasSignal).toBe(true);
    expect(hasCallTool).toBe(true);
    expect(hasReportProgress).toBe(true);

    await app.stop();
  });

  it('supports context returning primitive values or null gracefully', async () => {
    const { ContextManager } = await import('../src/server/context.js');

    const primitiveManager = new ContextManager(async () => 12345);
    const primResult = await primitiveManager.initialize();
    expect(primResult).toBe(12345);
    expect(primitiveManager.getContext()).toBe(12345);

    const nullManager = new ContextManager(async () => null);
    const nullResult = await nullManager.initialize();
    expect(nullResult).toBeNull();
    expect(nullManager.getContext()).toBeNull();
  });

  it('shares context across inter-tool calls without re-initializing or losing state', async () => {
    const app = createMcpServer({
      name: 'inter-tool-ctx-app',
      dataDir: testDir,
      context: () => ({ prefix: '>> ', sequence: 100 })
    });

    app.tool({
      name: 'inner_tool',
      inputSchema: { msg: 'string' },
      async handler({ msg }, ctx) {
        return `${ctx.prefix}${msg} (${ctx.sequence})`;
      }
    });

    app.tool({
      name: 'outer_tool',
      inputSchema: { input: 'string' },
      async handler({ input }, _ctx, { callTool }) {
        const inner = await callTool('inner_tool', { msg: input });
        return { transformed: inner.data };
      }
    });

    await app.start();
    const result = await app.callTool('outer_tool', { input: 'hello' });
    expect(result.data).toEqual({ transformed: '>> hello (100)' });
    await app.stop();
  });

  it('returns empty object when getContext is called on ContextManager without factory', async () => {
    const { ContextManager } = await import('../src/server/context.js');
    const noFactory = new ContextManager();
    // Before initialization, if no factory exists, getContext returns undefined/cached
    expect(noFactory.getContext()).toBeUndefined();
    await noFactory.initialize();
    expect(noFactory.getContext()).toEqual({});
  });

  it('preserves context object identity when accessed synchronously via app.contextManager', async () => {
    const initialObj = { initializedAt: new Date().toISOString(), tags: ['prod', 'v1'] };
    const app = createMcpServer({
      name: 'identity-app',
      dataDir: testDir,
      context: () => initialObj
    });

    await app.start();
    const ctx = app.contextManager.getContext();
    expect(ctx).toBe(initialObj);
    expect(ctx.tags).toContain('prod');
    await app.stop();
  });
});
