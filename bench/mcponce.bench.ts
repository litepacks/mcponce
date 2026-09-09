import { bench, describe, afterAll } from 'vitest';
import {
  createMcpServer,
  stableSerialize,
  ToolCacheManager,
  normalizeInputSchema,
  coerceArguments,
  coerceBoolean,
  coerceNumber,
  ConcurrencyQueue
} from '../src/index.js';
import { AnalyticsCollector } from '../src/server/analytics.js';

// --- Suite 1 Setup (Top-level ESM) ---
const app = createMcpServer({
  name: 'benchmark-server',
  version: '1.0.0'
});

// 1. Baseline tool
app.tool({
  name: 'baseline_add',
  inputSchema: { a: 'number', b: 'number' },
  handler: ({ a, b }) => ({ sum: a + b })
});

// 2. Coerced tool
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

// 3. Cached tool
app.tool({
  name: 'cached_tool',
  cache: { ttlMs: 60000, maxSize: 1000 },
  inputSchema: { id: 'number' },
  handler: ({ id }) => ({ id, data: `data_${id}` })
});
// Prime the cache
await app.callTool('cached_tool', { id: 99 });

// 4. Tool with 3 middlewares
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

// 5. Inter-tool calling
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

// --- Suite 3 Setup (Top-level ESM HTTP server) ---
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

// -------------------------------------------------------------
// Benchmark Suites
// -------------------------------------------------------------

describe('1. Programmatic Tool Invocations (app.callTool)', () => {
  bench('Baseline tool invocation (validation + execution)', async () => {
    await app.callTool('baseline_add', { a: 21, b: 21 });
  });

  bench('Tool with Smart Input Coercion (string -> typed)', async () => {
    await app.callTool('coerced_tool', { count: '42', active: 'true' });
  });

  bench('Tool with Response Cache Hit (hot in-memory cache)', async () => {
    await app.callTool('cached_tool', { id: 99 });
  });

  bench('Tool with 3 Onion Middlewares (inspection + mutation)', async () => {
    await appWithMiddleware.callTool('mw_tool', { x: 10 });
  });

  bench('Inter-tool calling (outer -> inner)', async () => {
    await app.callTool('outer_tool', { val: 4 });
  });
});

describe('2. Core Subsystems Microbenchmarks', () => {
  const cacheManager = new ToolCacheManager();
  const sampleArgs = { user: 'ahmet', role: 'admin', tags: ['fast', 'mcp'], count: 42 };
  const analytics = new AnalyticsCollector();

  bench('stableSerialize (cache key generation)', () => {
    stableSerialize(sampleArgs);
  });

  bench('cacheManager.set & get', () => {
    cacheManager.set('test_tool', sampleArgs, { data: 123 }, { ttlMs: 10000 });
    cacheManager.get('test_tool', sampleArgs, { ttlMs: 10000 });
  });

  bench('smartCoerceValue & coerceArguments', () => {
    coerceNumber('12345');
    coerceBoolean('false');
    coerceArguments({ id: '99', ok: 'true', list: '[1, 2, 3]' }, {
      id: 'number',
      ok: 'boolean',
      list: 'array'
    });
  });

  bench('normalizeInputSchema compilation', () => {
    normalizeInputSchema({
      query: 'string',
      limit: { type: 'number', default: 20 },
      inStock: { type: 'boolean', default: true }
    }, 'sample_tool');
  });

  bench('ConcurrencyQueue acquire & release', async () => {
    const q = new ConcurrencyQueue(1);
    const release = await q.acquire();
    release();
  });

  bench('AnalyticsCollector.recordInvocation', () => {
    analytics.recordInvocation({
      tool: 'bench_tool',
      durationMs: 1.25,
      status: 'success',
      caller: 'workflow'
    });
  });

  bench('AnalyticsCollector.toPrometheusFormat', () => {
    analytics.toPrometheusFormat({
      serverName: 'bench-server',
      version: '1.0.0',
      activeSessions: 5,
      totalSessions: 20,
      uptimeSeconds: 123.45,
      cacheStats: cacheManager.getStats()
    });
  });
});

describe('3. End-to-End HTTP / MCP Transport (/mcp)', () => {
  bench('HTTP POST /mcp tools/call (Full JSON-RPC over HTTP socket)', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'bench-req',
        method: 'tools/call',
        params: {
          name: 'fast_calc',
          arguments: { n: 10 }
        }
      })
    });
    await response.text();
  });

  bench('HTTP GET /metrics (Prometheus scrape endpoint)', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    await response.text();
  });
});

afterAll(async () => {
  await httpApp.stop({ force: true });
  await app.stop({ force: true });
  await appWithMiddleware.stop({ force: true });
});
