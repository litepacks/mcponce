---
title: Prometheus Metrics
description: Native Prometheus text format metrics exporter for Grafana, Datadog, and Kubernetes monitoring.
---

# Prometheus Metrics

`mcponce` provides native, zero-dependency **Prometheus metrics export** compliant with the standard Prometheus text format (`text/plain; version=0.0.4`). You can scrape your MCP servers directly with Prometheus, VictoriaMetrics, Datadog, or Grafana Agent without needing external sidecar exporters.

---

## The `/metrics` Endpoint

Every `mcponce` HTTP server exposes `/metrics` by default:

```bash
curl http://localhost:3000/metrics
```

Example Prometheus output:

```text
# HELP mcp_server_uptime_seconds Total time the server has been running in seconds.
# TYPE mcp_server_uptime_seconds gauge
mcp_server_uptime_seconds 3600.25

# HELP mcp_active_sessions Current active MCP client connections.
# TYPE mcp_active_sessions gauge
mcp_active_sessions 2

# HELP mcp_invocations_total Total number of tool invocations partitioned by tool and status.
# TYPE mcp_invocations_total counter
mcp_invocations_total{tool="get_weather",status="success"} 450
mcp_invocations_total{tool="get_weather",status="failure"} 3
mcp_invocations_total{tool="get_weather",status="cached"} 120

# HELP mcp_tool_retries_total Total retry attempts executed for tools.
# TYPE mcp_tool_retries_total counter
mcp_tool_retries_total{tool="get_weather"} 5

# HELP mcp_invocation_duration_seconds_avg Average duration of tool executions in seconds.
# TYPE mcp_invocation_duration_seconds_avg gauge
mcp_invocation_duration_seconds_avg{tool="get_weather"} 0.0452

# HELP mcp_cache_size Current number of items in memory cache.
# TYPE mcp_cache_size gauge
mcp_cache_size 85

# HELP mcp_cache_hits_total Total number of cache hits.
# TYPE mcp_cache_hits_total counter
mcp_cache_hits_total 120
```

---

## Programmatic Metric Export

If you embed `mcponce` inside custom HTTP routers (Express, Fastify, Next.js, or Cloudflare Workers), generate Prometheus output directly with `app.getMetrics()`:

```typescript
import { createMcpServer } from 'mcponce';

const app = createMcpServer({ name: 'my-service' });

// Export formatted string
const prometheusText = app.getMetrics({
  serverName: 'production-cluster-01',
  version: '1.2.0'
});

console.log(prometheusText);
```

---

## Prometheus Scrape Configuration

Add your `mcponce` server to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'mcponce_servers'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3000']
```

---

## Recommended Alert Rules

| Metric Alert | Threshold | Action |
| :--- | :--- | :--- |
| **High Error Rate** | `rate(mcp_invocations_total{status="failure"}[5m]) > 0.05` | Check upstream API keys or network status. |
| **Excessive Retries** | `rate(mcp_tool_retries_total[5m]) > 2` | Third-party service is experiencing flakiness or throttling. |
| **Spike in Duration** | `mcp_invocation_duration_seconds_avg > 5.0` | Investigate database query plans or network latency. |
