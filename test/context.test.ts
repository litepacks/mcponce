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
});
