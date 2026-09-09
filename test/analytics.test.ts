import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../src/index.js';
import { AnalyticsCollector } from '../src/server/analytics.js';
import { fetchAnalytics } from '../src/cli/analytics.js';

describe('Tool Analytics & Telemetry', () => {
  it('1. AnalyticsCollector correctly calculates counts, durations, and ring buffer', () => {
    const collector = new AnalyticsCollector({ maxRecentEntries: 3 });

    collector.recordInvocation({ tool: 'toolA', durationMs: 10, status: 'success' });
    collector.recordInvocation({ tool: 'toolA', durationMs: 20, status: 'success' });
    collector.recordInvocation({ tool: 'toolB', durationMs: 50, status: 'error', errorMessage: 'Failed' });
    collector.recordInvocation({ tool: 'toolC', durationMs: 100, status: 'timeout' });

    const snap = collector.getSnapshot();

    expect(snap.summary.totalInvocations).toBe(4);
    expect(snap.summary.successfulInvocations).toBe(2);
    expect(snap.summary.failedInvocations).toBe(2); // 1 error + 1 timeout
    expect(snap.summary.timeoutInvocations).toBe(1);
    expect(snap.summary.totalExecutionTimeMs).toBe(180);
    expect(snap.summary.averageExecutionTimeMs).toBe(45); // 180 / 4

    // toolA metrics
    const a = snap.tools['toolA'];
    expect(a.calls).toBe(2);
    expect(a.success).toBe(2);
    expect(a.totalDurationMs).toBe(30);
    expect(a.avgDurationMs).toBe(15);
    expect(a.minDurationMs).toBe(10);
    expect(a.maxDurationMs).toBe(20);

    // Ring buffer size limited to 3
    expect(snap.recentInvocations.length).toBe(3);
    // Oldest invocation (id: 1) was evicted
    expect(snap.recentInvocations[0].tool).toBe('toolA');
    expect(snap.recentInvocations[0].id).toBe(2);
    expect(snap.recentInvocations[2].tool).toBe('toolC');
    expect(snap.recentInvocations[2].status).toBe('timeout');

    // Reset
    collector.reset();
    const emptySnap = collector.getSnapshot();
    expect(emptySnap.summary.totalInvocations).toBe(0);
    expect(emptySnap.recentInvocations.length).toBe(0);
  });

  it('2. tracks tool invocations and execution times through app.callTool', async () => {
    const app = createMcpServer('test-analytics-app');

    app.tool({
      name: 'fast_calc',
      inputSchema: { n: 'number' },
      handler: ({ n }) => n * 2
    });

    app.tool({
      name: 'slow_op',
      inputSchema: {},
      handler: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return 'done';
      }
    });

    await app.callTool('fast_calc', { n: 21 });
    await app.callTool('fast_calc', { n: 42 });
    await app.callTool('slow_op');

    const analytics = app.getAnalytics();
    expect(analytics.summary.totalInvocations).toBe(3);
    expect(analytics.summary.successfulInvocations).toBe(3);

    const fast = analytics.tools['fast_calc'];
    expect(fast.calls).toBe(2);
    expect(fast.success).toBe(2);

    const slow = analytics.tools['slow_op'];
    expect(slow.calls).toBe(1);
    expect(slow.lastDurationMs).toBeGreaterThanOrEqual(40);
  });

  it('3. tracks inter-tool calls (call graph) accurately', async () => {
    const app = createMcpServer('test-analytics-graph');

    app.tool({
      name: 'add',
      inputSchema: { a: 'number', b: 'number' },
      handler: ({ a, b }) => a + b
    });

    app.tool({
      name: 'multiply',
      inputSchema: { x: 'number', y: 'number' },
      handler: ({ x, y }) => x * y
    });

    app.tool({
      name: 'workflow',
      inputSchema: {},
      handler: async (args, { callTool }) => {
        const sum = await callTool('add', { a: 2, b: 3 });
        const mult = await callTool('multiply', { x: sum.data, y: 10 });
        return mult.data;
      }
    });

    const res = await app.callTool('workflow');
    expect(res.data).toBe(50);

    const analytics = app.getAnalytics();
    // 3 total invocations: 1 workflow + 1 add + 1 multiply
    expect(analytics.summary.totalInvocations).toBe(3);
    expect(analytics.summary.totalInterToolCalls).toBe(2);

    // Verify interToolCalls call graph
    expect(analytics.interToolCalls).toEqual(
      expect.arrayContaining([
        { caller: 'workflow', target: 'add', count: 1 },
        { caller: 'workflow', target: 'multiply', count: 1 }
      ])
    );

    // Verify per-tool callers & invokedTools
    expect(analytics.tools['add'].callers['workflow']).toBe(1);
    expect(analytics.tools['multiply'].callers['workflow']).toBe(1);
    expect(analytics.tools['workflow'].invokedTools['add']).toBe(1);
    expect(analytics.tools['workflow'].invokedTools['multiply']).toBe(1);

    // Run workflow a second time
    await app.callTool('workflow');
    const updated = app.getAnalytics();
    expect(updated.summary.totalInvocations).toBe(6);
    expect(updated.summary.totalInterToolCalls).toBe(4);
    expect(updated.tools['add'].callers['workflow']).toBe(2);
  });

  it('4. tracks timeouts, cancellations, and errors in analytics', async () => {
    const app = createMcpServer('test-analytics-errors');

    app.tool({
      name: 'failing',
      inputSchema: {},
      handler: () => {
        throw new Error('Database disconnected');
      }
    });

    app.tool({
      name: 'timing_out',
      timeoutMs: 50,
      inputSchema: {},
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'ok';
      }
    });

    // 1. Failing tool call
    const failRes = await app.callTool('failing', {}, { throwOnError: false });
    expect(failRes.isError).toBe(true);

    // 2. Timeout tool call
    const timeoutRes = await app.callTool('timing_out', {}, { throwOnError: false });
    expect(timeoutRes.isError).toBe(true);

    const analytics = app.getAnalytics();
    expect(analytics.summary.failedInvocations).toBe(2);
    expect(analytics.summary.timeoutInvocations).toBe(1);

    expect(analytics.tools['failing'].errors).toBe(1);
    expect(analytics.tools['timing_out'].timeouts).toBe(1);

    const recent = analytics.recentInvocations;
    expect(recent[0].status).toBe('error');
    expect(recent[0].errorMessage).toContain('Database disconnected');
    expect(recent[1].status).toBe('timeout');
    expect(recent[1].errorMessage).toContain('timed out after 50ms');
  });

  it('5. serves analytics over HTTP via GET /analytics and GET /info', async () => {
    const app = createMcpServer({
      name: 'test-http-analytics',
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'ping',
      inputSchema: {},
      handler: () => 'pong'
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      // Invoke ping
      await app.callTool('ping');

      // 1. Query GET /analytics
      const analyticsRes = await fetch(`${baseUrl}/analytics`);
      expect(analyticsRes.status).toBe(200);
      const analytics = await analyticsRes.json();

      expect(analytics.summary.totalInvocations).toBe(1);
      expect(analytics.summary.successfulInvocations).toBe(1);
      expect(analytics.tools['ping'].calls).toBe(1);

      // 2. Query GET /info (should include analytics summary)
      const infoRes = await fetch(`${baseUrl}/info`);
      expect(infoRes.status).toBe(200);
      const info = await infoRes.json();

      expect(info.analytics).toBeDefined();
      expect(info.analytics.totalInvocations).toBe(1);
      expect(info.analytics.successfulInvocations).toBe(1);

      // 3. fetchAnalytics helper from CLI module
      const cliAnalytics = await fetchAnalytics(startResult.host, startResult.port);
      expect(cliAnalytics).not.toBeNull();
      expect(cliAnalytics?.summary.totalInvocations).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('6. provides built-in system://analytics resource for MCP clients', async () => {
    const app = createMcpServer({
      name: 'test-resource-analytics',
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'sample_tool',
      handler: () => ({ ok: true })
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      // Call sample_tool
      await app.callTool('sample_tool');

      // 1. Initialize MCP session
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
      const sessionId = initRes.headers.get('mcp-session-id') || undefined;

      // 2. Read resource system://analytics
      const readRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/read',
          params: {
            uri: 'system://analytics'
          }
        })
      });

      expect(readRes.status).toBe(200);
      const rawText = await readRes.text();
      const jsonLine = rawText.split('\n').find((l) => l.startsWith('data: '))?.replace(/^data: /, '') || rawText;
      const data = JSON.parse(jsonLine);

      expect(data.result.contents[0].uri).toBe('system://analytics');
      const parsedAnalytics = JSON.parse(data.result.contents[0].text);
      expect(parsedAnalytics.summary.totalInvocations).toBe(1);
      expect(parsedAnalytics.tools['sample_tool'].calls).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('7. records analytics accurately when tools are called via MCP protocol (POST /mcp tools/call)', async () => {
    const app = createMcpServer({
      name: 'test-mcp-protocol-analytics',
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'hello',
      inputSchema: { name: 'string' },
      handler: ({ name }) => `Hello ${name}!`
    });

    let computeCount = 0;
    app.tool({
      name: 'cached_calc',
      inputSchema: { n: 'number' },
      cache: { ttlMs: 60000 },
      handler: ({ n }) => {
        computeCount++;
        return n * 2;
      }
    });

    app.tool({
      name: 'fail_mcp',
      inputSchema: {},
      handler: () => {
        throw new Error('Simulated MCP protocol error');
      }
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      const sendMcpCall = async (tool: string, args: Record<string, any> = {}) => {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
              name: tool,
              arguments: args
            }
          })
        });
        const text = await res.text();
        const dataLine = text.split('\n').find((l) => l.startsWith('data: '))?.replace(/^data: /, '') || text;
        return JSON.parse(dataLine);
      };

      // 1. Call hello twice
      const r1 = await sendMcpCall('hello', { name: 'Ahmet' });
      expect(r1.result.content[0].text).toBe('Hello Ahmet!');
      const r2 = await sendMcpCall('hello', { name: 'Simsek' });
      expect(r2.result.content[0].text).toBe('Hello Simsek!');

      // 2. Call cached_calc twice (first normal, second cache hit)
      const c1 = await sendMcpCall('cached_calc', { n: 10 });
      expect(c1.result.content[0].text).toBe('20');
      const c2 = await sendMcpCall('cached_calc', { n: 10 });
      expect(c2.result.content[0].text).toBe('20');
      expect(computeCount).toBe(1);

      // 3. Call failing tool
      const f1 = await sendMcpCall('fail_mcp');
      expect(f1.result.isError).toBe(true);

      // 4. Verify analytics
      const analyticsRes = await fetch(`${baseUrl}/analytics`);
      const analytics = await analyticsRes.json();

      expect(analytics.summary.totalInvocations).toBe(5);
      expect(analytics.summary.successfulInvocations).toBe(4);
      expect(analytics.summary.failedInvocations).toBe(1);
      expect(analytics.summary.cachedInvocations).toBe(1);

      expect(analytics.tools['hello'].calls).toBe(2);
      expect(analytics.tools['hello'].success).toBe(2);
      expect(analytics.tools['cached_calc'].calls).toBe(2);
      expect(analytics.tools['fail_mcp'].calls).toBe(1);
      expect(analytics.tools['fail_mcp'].errors).toBe(1);

      // 5. Verify server metrics lastToolInvocation
      const infoRes = await fetch(`${baseUrl}/info`);
      const info = await infoRes.json();
      expect(info.lastToolInvocation?.name).toBe('fail_mcp');
    } finally {
      await app.stop();
    }
  });
});
