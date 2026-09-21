import {
  createMcpServer,
  stableSerialize,
  ToolCacheManager,
  normalizeInputSchema,
  coerceArguments,
  coerceBoolean,
  coerceNumber,
  ConcurrencyQueue
} from '../dist/index.js';
import { AnalyticsCollector } from '../dist/server/analytics.js';

async function main() {
  console.log('🚀 Starting mcponce benchmark runner for Softscope profiling...');

  // --- Suite 1: Programmatic Tool Invocations ---
  const app = createMcpServer({
    name: 'benchmark-server',
    version: '1.0.0'
  });

  app.tool({
    name: 'baseline_add',
    inputSchema: { a: 'number', b: 'number' },
    handler: ({ a, b }) => ({ sum: a + b })
  });

  app.tool({
    name: 'coerced_tool',
    coerceInputs: true,
    inputSchema: {
      count: { type: 'number', default: 10 },
      active: { type: 'boolean', default: false },
      tag: { type: 'string', default: 'general' }
    },
    handler: (args) => args
  });

  app.tool({
    name: 'cached_tool',
    cache: { ttlMs: 60000, maxSize: 1000 },
    inputSchema: { id: 'number' },
    handler: ({ id }) => ({ id, data: `data_${id}` })
  });
  // Prime cache
  await app.callTool('cached_tool', { id: 99 });

  const appWithMiddleware = createMcpServer({ name: 'benchmark-mw' });
  appWithMiddleware
    .use(async (ctx, next) => {
      ctx.args._m1 = true;
      return next();
    })
    .use(async (ctx, next) => {
      ctx.context.trace = 'm2';
      return next();
    })
    .use(async (_ctx, next) => {
      const res = await next();
      return res;
    })
    .tool({
      name: 'mw_tool',
      inputSchema: { x: 'number' },
      handler: ({ x }) => x * 2
    });

  app.tool({
    name: 'inner_tool',
    inputSchema: { val: 'number' },
    handler: ({ val }) => val * 10
  });

  app.tool({
    name: 'outer_tool',
    inputSchema: { val: 'number' },
    handler: async ({ val }, { callTool }) => {
      const innerRes = await callTool('inner_tool', { val });
      return { result: innerRes.data + 5 };
    }
  });

  console.log('Running Suite 1: Programmatic Tool Invocations...');
  for (let i = 0; i < 2000; i++) {
    await app.callTool('baseline_add', { a: 21, b: 21 });
    await app.callTool('coerced_tool', { count: '42', active: 'true' });
    await app.callTool('cached_tool', { id: 99 });
    await appWithMiddleware.callTool('mw_tool', { x: 10 });
    await app.callTool('outer_tool', { val: 4 });
  }

  // --- Suite 2: Core Subsystems Microbenchmarks ---
  console.log('Running Suite 2: Core Subsystems Microbenchmarks...');
  const cacheManager = new ToolCacheManager();
  const sampleArgs = { user: 'ahmet', role: 'admin', tags: ['fast', 'mcp'], count: 42 };
  const analytics = new AnalyticsCollector();

  for (let i = 0; i < 20000; i++) {
    stableSerialize(sampleArgs);
    cacheManager.set('test_tool', sampleArgs, { data: 123 }, { ttlMs: 10000 });
    cacheManager.get('test_tool', sampleArgs, { ttlMs: 10000 });

    coerceNumber('12345');
    coerceBoolean('false');
    coerceArguments({ id: '99', ok: 'true', list: '[1, 2, 3]' }, {
      id: 'number',
      ok: 'boolean',
      list: 'array'
    });

    normalizeInputSchema({
      query: 'string',
      limit: { type: 'number', default: 20 },
      inStock: { type: 'boolean', default: true }
    }, 'sample_tool');

    const q = new ConcurrencyQueue(1);
    const release = await q.acquire();
    release();

    analytics.recordInvocation({
      tool: 'bench_tool',
      durationMs: 1.25,
      status: 'success',
      caller: 'workflow'
    });

    if (i % 2 === 0) {
      analytics.toPrometheusFormat({
        serverName: 'bench-server',
        version: '1.0.0',
        activeSessions: 5,
        totalSessions: 20,
        uptimeSeconds: 123.45,
        cacheStats: cacheManager.getStats()
      });
    }
  }

  // --- Suite 3: End-to-End HTTP Transport ---
  console.log('Running Suite 3: End-to-End HTTP Transport...');
  const httpApp = createMcpServer({
    name: 'bench-http-server',
    port: 0
  });
  httpApp.tool({
    name: 'fast_calc',
    inputSchema: { n: 'number' },
    handler: ({ n }) => ({ doubled: n * 2 })
  });
  const httpRes = await httpApp.start({ role: 'owner' });
  const baseUrl = `http://${httpRes.host}:${httpRes.port}`;

  const postPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 'bench-req',
    method: 'tools/call',
    params: {
      name: 'fast_calc',
      arguments: { n: 10 }
    }
  });

  for (let i = 0; i < 300; i++) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: postPayload
    });
    await response.text();

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    await metricsRes.text();
  }

  await httpApp.stop({ force: true });
  await app.stop({ force: true });
  await appWithMiddleware.stop({ force: true });

  console.log('✅ Benchmarks completed successfully.');
}

main().catch((err) => {
  console.error('Benchmark runner error:', err);
  process.exit(1);
});
