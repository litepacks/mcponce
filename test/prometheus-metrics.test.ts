import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMcpServer, McpApp } from '../src/index.js';
import { AnalyticsCollector } from '../src/server/analytics.js';

describe('Prometheus Metrics Export (GET /metrics & app.getMetrics)', () => {
  let app: McpApp;

  beforeEach(() => {
    app = createMcpServer({
      name: 'metrics-test-server',
      version: '1.2.3',
      port: 0
    });
  });

  afterEach(async () => {
    await app.stop({ force: true });
  });

  it('generates standard Prometheus 0.0.4 format via AnalyticsCollector', () => {
    const collector = new AnalyticsCollector();

    collector.recordInvocation({
      tool: 'weather',
      durationMs: 15.5,
      status: 'success'
    });

    collector.recordInvocation({
      tool: 'weather',
      durationMs: 12.0,
      status: 'success',
      isCacheHit: true
    });

    collector.recordInvocation({
      tool: 'db_query',
      caller: 'weather',
      durationMs: 45.0,
      status: 'error',
      retries: 2
    });

    const output = collector.toPrometheusFormat({
      serverName: 'test_srv',
      version: '1.0.0',
      activeSessions: 2,
      totalSessions: 5,
      uptimeSeconds: 120.5,
      cacheStats: { size: 1, hits: 1, misses: 2, evictions: 0 }
    });

    // Verify HELP and TYPE headers
    expect(output).toContain('# HELP mcp_server_info');
    expect(output).toContain('# TYPE mcp_server_info gauge');
    expect(output).toContain('mcp_server_info{server="test_srv",version="1.0.0"} 1');

    expect(output).toContain('# HELP mcp_server_uptime_seconds');
    expect(output).toContain('mcp_server_uptime_seconds{server="test_srv"} 120.50');

    expect(output).toContain('# HELP mcp_active_sessions');
    expect(output).toContain('mcp_active_sessions{server="test_srv"} 2');

    expect(output).toContain('# HELP mcp_tool_invocations_total');
    expect(output).toContain('mcp_tool_invocations_total{server="test_srv",status="success"} 2');
    expect(output).toContain('mcp_tool_invocations_total{server="test_srv",status="error"} 1');

    expect(output).toContain('mcp_tool_calls_total{server="test_srv",tool="weather",status="success"} 2');
    expect(output).toContain('mcp_tool_calls_total{server="test_srv",tool="db_query",status="error"} 1');

    expect(output).toContain('mcp_tool_cache_hits_total{server="test_srv",tool="weather"} 1');
    expect(output).toContain('mcp_tool_retries_total{server="test_srv",tool="db_query"} 2');

    expect(output).toContain('mcp_inter_tool_calls_total{server="test_srv",caller="weather",target="db_query"} 1');

    expect(output).toContain('mcp_cache_entries{server="test_srv"} 1');
    expect(output).toContain('mcp_cache_hits_total{server="test_srv"} 1');
  });

  it('exports metrics programmatically via app.getMetrics()', async () => {
    app.tool({
      name: 'calc',
      inputSchema: { n: 'number' },
      handler: ({ n }) => n * 2
    });

    await app.callTool('calc', { n: 5 });
    await app.callTool('calc', { n: 10 });

    const metricsText = app.getMetrics();
    expect(metricsText).toContain('mcp_server_info{server="metrics-test-server",version="1.2.3"} 1');
    expect(metricsText).toContain('mcp_tool_invocations_total{server="metrics-test-server",status="success"} 2');
    expect(metricsText).toContain('mcp_tool_calls_total{server="metrics-test-server",tool="calc",status="success"} 2');
  });

  it('serves Prometheus metrics over HTTP GET /metrics with correct headers', async () => {
    app.tool({
      name: 'ping',
      handler: () => 'pong'
    });

    const startRes = await app.start({ role: 'owner' });
    const baseUrl = `http://${startRes.host}:${startRes.port}`;

    await app.callTool('ping', {});

    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4');

    const body = await res.text();
    expect(body).toContain('# HELP mcp_server_info');
    expect(body).toContain('mcp_tool_calls_total{server="metrics-test-server",tool="ping",status="success"} 1');
    expect(body).toContain('mcp_active_sessions{server="metrics-test-server"}');
  });

  it('exposes built-in MCP resource system://metrics', async () => {
    app.tool({
      name: 'hello',
      handler: () => 'world'
    });

    await app.callTool('hello', {});

    const resource = app.getResource('system://metrics');
    expect(resource).toBeDefined();
    expect(resource?.mimeType).toContain('text/plain');

    const readRes = await resource!.handler(new URL('system://metrics'), {} as any);
    expect(readRes.contents).toHaveLength(1);
    expect(readRes.contents[0].text).toContain('# HELP mcp_tool_calls_total');
    expect(readRes.contents[0].text).toContain('tool="hello"');
  });

  it('safely escapes special characters in tool and server names', () => {
    const collector = new AnalyticsCollector();

    collector.recordInvocation({
      tool: 'tricky"tool\\name\n',
      durationMs: 10,
      status: 'success'
    });

    const output = collector.toPrometheusFormat({
      serverName: 'server"with\\quotes\n'
    });

    expect(output).toContain('server="server\\"with\\\\quotes\\n"');
    expect(output).toContain('tool="tricky\\"tool\\\\name\\n"');
  });
});
