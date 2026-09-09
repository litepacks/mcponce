import { describe, it, expect, vi } from 'vitest';
import { createMcpServer } from '../src/server/app.js';
import { stableSerialize, ToolCacheManager } from '../src/utils/cache.js';

describe('In-Memory Tool Response Caching', () => {
  describe('stableSerialize', () => {
    it('serializes objects deterministically with sorted keys at all levels', () => {
      const obj1 = { b: 2, a: 1, c: { z: 26, y: 25 } };
      const obj2 = { a: 1, c: { y: 25, z: 26 }, b: 2 };

      expect(stableSerialize(obj1)).toBe(stableSerialize(obj2));
      expect(stableSerialize(obj1)).toBe('{"a":1,"b":2,"c":{"y":25,"z":26}}');
    });

    it('handles arrays and primitives correctly', () => {
      expect(stableSerialize([3, 2, 1])).toBe('[3,2,1]');
      expect(stableSerialize('test')).toBe('"test"');
      expect(stableSerialize(42)).toBe('42');
      expect(stableSerialize(true)).toBe('true');
      expect(stableSerialize(null)).toBe('null');
    });
  });

  describe('ToolCacheManager Unit Tests', () => {
    it('stores, retrieves, and tracks cache hits and misses', () => {
      const cache = new ToolCacheManager();
      const mockResult: any = { content: [{ type: 'text', text: 'result' }], data: 'result', text: 'result' };

      expect(cache.get('weather', { city: 'London' })).toBeUndefined();
      expect(cache.getStats().misses).toBe(1);

      cache.set('weather', { city: 'London' }, mockResult, { ttlMs: 1000 });

      const retrieved = cache.get('weather', { city: 'London' });
      expect(retrieved).toEqual(mockResult);
      expect(cache.getStats().hits).toBe(1);
    });

    it('evicts least recently used (LRU) entry when maxSize is reached', () => {
      const cache = new ToolCacheManager();
      const mockResult: any = { content: [], data: null, text: '' };

      // Set max capacity to 2
      cache.set('calc', { a: 1 }, mockResult, { maxSize: 2 });
      cache.set('calc', { a: 2 }, mockResult, { maxSize: 2 });

      // Access key a: 1 to make it most recently used
      cache.get('calc', { a: 1 });

      // Insert third entry - should evict a: 2 (least recently used)
      cache.set('calc', { a: 3 }, mockResult, { maxSize: 2 });

      expect(cache.get('calc', { a: 1 })).toBeDefined();
      expect(cache.get('calc', { a: 2 })).toBeUndefined();
      expect(cache.get('calc', { a: 3 })).toBeDefined();
      expect(cache.getStats().evictions).toBe(1);
    });

    it('expires entries after ttlMs', async () => {
      const cache = new ToolCacheManager();
      const mockResult: any = { content: [], data: 'ok', text: 'ok' };

      cache.set('quote', { symbol: 'AAPL' }, mockResult, { ttlMs: 25 });
      expect(cache.get('quote', { symbol: 'AAPL' })).toBeDefined();

      await new Promise((r) => setTimeout(r, 40));
      expect(cache.get('quote', { symbol: 'AAPL' })).toBeUndefined();
    });

    it('selectively clears by tool name and clears all', () => {
      const cache = new ToolCacheManager();
      const mockResult: any = { content: [], data: 'ok', text: 'ok' };

      cache.set('tool_a', { id: 1 }, mockResult);
      cache.set('tool_a', { id: 2 }, mockResult);
      cache.set('tool_b', { id: 1 }, mockResult);

      expect(cache.getStats().size).toBe(3);

      // Clear tool_a only
      const clearedA = cache.clear('tool_a');
      expect(clearedA).toBe(2);
      expect(cache.get('tool_a', { id: 1 })).toBeUndefined();
      expect(cache.get('tool_b', { id: 1 })).toBeDefined();

      // Clear all
      const clearedAll = cache.clear();
      expect(clearedAll).toBe(1);
      expect(cache.getStats().size).toBe(0);
    });

    it('handles custom keyGenerator, existing key overwrite, and resetStats', () => {
      const cache = new ToolCacheManager();
      const mockResult1: any = { text: 'r1' };
      const mockResult2: any = { text: 'r2' };
      const config = { keyGenerator: (args: any) => `custom:${args.id}` };

      // custom key generator
      cache.set('tool_custom', { id: 'x1' }, mockResult1, config);
      expect(cache.get('tool_custom', { id: 'x1' }, config)).toEqual(mockResult1);

      // overwrite existing key
      cache.set('tool_custom', { id: 'x1' }, mockResult2, config);
      expect(cache.get('tool_custom', { id: 'x1' }, config)).toEqual(mockResult2);

      // resetStats
      expect(cache.getStats().hits).toBeGreaterThan(0);
      cache.resetStats();
      expect(cache.getStats().hits).toBe(0);
      expect(cache.getStats().misses).toBe(0);
      expect(cache.getStats().evictions).toBe(0);
    });
  });

  describe('Server Tool Caching Integration', () => {
    it('caches tool responses and skips handler execution on identical calls', async () => {
      const app = createMcpServer({ name: 'test-cache-server' });
      let executionCount = 0;

      app.tool({
        name: 'get_rate',
        inputSchema: { currency: 'string' },
        cache: true, // Default 60s cache
        async handler({ currency }) {
          executionCount++;
          return { currency, rate: 1.25, timestamp: Date.now() };
        }
      });

      // 1. First execution
      const res1 = await app.callTool('get_rate', { currency: 'EUR' });
      expect(executionCount).toBe(1);
      expect(res1.data.currency).toBe('EUR');

      // 2. Second execution with identical args: returns cached result immediately
      const res2 = await app.callTool('get_rate', { currency: 'EUR' });
      expect(executionCount).toBe(1); // Handler was not re-executed!
      expect(res2.data).toEqual(res1.data);

      // 3. Different args: executes handler
      const res3 = await app.callTool('get_rate', { currency: 'USD' });
      expect(executionCount).toBe(2);
      expect(res3.data.currency).toBe('USD');

      // 4. Analytics reflect cache hit
      const analytics = app.getAnalytics();
      expect(analytics.summary.cachedInvocations).toBe(1);
      expect(analytics.tools['get_rate'].cacheHits).toBe(1);
    });

    it('matches cache keys regardless of argument property order', async () => {
      const app = createMcpServer({ name: 'test-order-server' });
      let count = 0;

      app.tool({
        name: 'compute',
        inputSchema: { a: 'number', b: 'number' },
        cache: { ttlMs: 10_000 },
        async handler({ a, b }) {
          count++;
          return { sum: a + b };
        }
      });

      // Call with { a: 10, b: 20 }
      await app.callTool('compute', { a: 10, b: 20 });
      expect(count).toBe(1);

      // Call with { b: 20, a: 10 } (different property order)
      const res2 = await app.callTool('compute', { b: 20, a: 10 });
      expect(count).toBe(1); // Hit cache!
      expect(res2.data.sum).toBe(30);
    });

    it('allows bypassing cache using noCache: true', async () => {
      const app = createMcpServer({ name: 'test-bypass-server' });
      let count = 0;

      app.tool({
        name: 'time_check',
        cache: true,
        async handler() {
          count++;
          return { count };
        }
      });

      const res1 = await app.callTool('time_check');
      expect(count).toBe(1);

      // Normal call hits cache
      const res2 = await app.callTool('time_check');
      expect(count).toBe(1);
      expect(res2.data.count).toBe(1);

      // Call with noCache: true forces fresh execution
      const res3 = await app.callTool('time_check', {}, { noCache: true });
      expect(count).toBe(2);
      expect(res3.data.count).toBe(2);
    });

    it('invalidates cache programmatically via app.clearCache', async () => {
      const app = createMcpServer({ name: 'test-clear-server' });
      let count = 0;

      app.tool({
        name: 'cached_data',
        cache: true,
        async handler() {
          count++;
          return { count };
        }
      });

      await app.callTool('cached_data');
      expect(count).toBe(1);

      // Clear cache for this tool
      const evicted = app.clearCache('cached_data');
      expect(evicted).toBe(1);

      // Next call re-executes handler
      const res2 = await app.callTool('cached_data');
      expect(count).toBe(2);
      expect(res2.data.count).toBe(2);
    });

    it('allows cache invalidation from inside another tool handler', async () => {
      const app = createMcpServer({ name: 'test-inter-tool-clear' });
      let counter = 100;
      let readCount = 0;

      app.tool({
        name: 'get_counter',
        cache: true,
        async handler() {
          readCount++;
          return { counter };
        }
      });

      app.tool({
        name: 'increment_counter',
        inputSchema: { amount: 'number' },
        async handler({ amount }, { clearCache }) {
          counter += amount;
          // Invalidate get_counter cache
          clearCache('get_counter');
          return { counter };
        }
      });

      // 1. Initial read (readCount = 1)
      const r1 = await app.callTool('get_counter');
      expect(r1.data.counter).toBe(100);
      expect(readCount).toBe(1);

      // 2. Read again (hits cache, readCount = 1)
      const r2 = await app.callTool('get_counter');
      expect(r2.data.counter).toBe(100);
      expect(readCount).toBe(1);

      // 3. Increment counter (clears get_counter cache)
      await app.callTool('increment_counter', { amount: 50 });
      expect(counter).toBe(150);

      // 4. Read again (re-executes because cache was invalidated!)
      const r3 = await app.callTool('get_counter');
      expect(r3.data.counter).toBe(150);
      expect(readCount).toBe(2);
    });

    it('does not cache failed tool executions or errors', async () => {
      const app = createMcpServer({ name: 'test-err-cache' });
      let attempts = 0;

      app.tool({
        name: 'flaky_service',
        cache: true,
        async handler() {
          attempts++;
          if (attempts === 1) {
            throw new Error('Transient 503 error');
          }
          return { status: 'recovered' };
        }
      });

      // First call fails
      const res1 = await app.callTool('flaky_service', {}, { throwOnError: false });
      expect(res1.isError).toBe(true);
      expect(attempts).toBe(1);

      // Second call does NOT return cached error, attempts re-execution
      const res2 = await app.callTool('flaky_service');
      expect(res2.isError).toBeFalsy();
      expect(res2.data.status).toBe('recovered');
      expect(attempts).toBe(2);

      // Third call hits cache of successful result
      const res3 = await app.callTool('flaky_service');
      expect(attempts).toBe(2);
      expect(res3.data.status).toBe('recovered');
    });

    it('caches tool responses invoked remotely by an MCP client over HTTP', async () => {
      const app = createMcpServer({
        name: 'test-remote-cache-mcp',
        port: 0
      });

      let handlerCalls = 0;
      app.tool({
        name: 'cached_lookup',
        inputSchema: { query: 'string' },
        cache: { ttlMs: 10_000 },
        async handler({ query }) {
          handlerCalls++;
          return { query, computed: query.toUpperCase() };
        }
      });

      const res = await app.start();
      try {
        const baseUrl = `http://${res.host}:${res.port}`;

        // Initialize MCP session
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
        expect(sessionId).toBeDefined();

        const callToolRemote = async (id: number) => {
          const resp = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json, text/event-stream',
              'mcp-session-id': sessionId
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: 'tools/call',
              params: { name: 'cached_lookup', arguments: { query: 'alpha' } }
            })
          });
          const text = await resp.text();
          const match = text.match(/data:\s*(\{.*\})/);
          return match ? JSON.parse(match[1]) : JSON.parse(text);
        };

        // 1. First remote MCP call
        const data1 = await callToolRemote(10);
        expect(data1.result.isError).toBeFalsy();
        expect(handlerCalls).toBe(1);

        // 2. Second remote MCP call with same args: served from cache!
        const data2 = await callToolRemote(20);
        expect(data2.result.isError).toBeFalsy();
        expect(handlerCalls).toBe(1); // Not incremented!
      } finally {
        await app.stop();
      }
    });
  });
});
