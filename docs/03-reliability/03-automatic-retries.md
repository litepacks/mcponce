---
title: Automatic Retries
description: Configurable exponential backoff, jitter, and selective retry filters for resilient remote execution.
---

# Automatic Retries

Network glitches, momentary rate limits (HTTP 429), and remote service restarts (HTTP 503) are common when tools connect to third-party APIs. Failing an entire agentic workflow due to a single transient glitch degrades the user experience.

**mcponce** provides a built-in **Exponential Backoff Retry Engine** with customizable delays, factors, and selective error filters.

---

## Basic Configuration

You can enable retries by specifying the number of attempts or passing a detailed `ToolRetryConfig`:

:::tabs group="retry-modes"
::tab Simple Count (Number)
```typescript
app.tool({
  name: 'fetch_weather',
  description: 'Fetches weather with 3 automatic retries',
  // Will retry up to 3 times with default exponential backoff (100ms, 200ms, 400ms)
  retry: 3,
  handler: async ({ city }) => {
    const res = await fetch(`https://api.weather.com/v1?city=${city}`);
    if (!res.ok) throw new Error(`Weather API failed: ${res.status}`);
    return res.json();
  }
});
```

::tab Advanced Settings (Object)
```typescript
app.tool({
  name: 'execute_remote_sql',
  description: 'Executes SQL query against cloud database with retry logic',
  retry: {
    attempts: 4,          // Retry up to 4 times
    backoffMs: 250,       // Start with 250ms initial delay
    factor: 2,            // Exponential multiplier (250ms, 500ms, 1000ms, 2000ms)
    maxBackoffMs: 5000,   // Maximum delay cap
    retryIf: (error) => {
      // Only retry transient network / connection drops
      const code = error?.code || error?.status;
      return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 503;
    }
  },
  handler: async ({ query }) => {
    return db.query(query);
  }
});
```
:::

---

## Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `attempts` | `number` | Required | Maximum number of retry attempts after the first failure. |
| `backoffMs` | `number` | `100` | Initial delay in milliseconds before the first retry. |
| `factor` | `number` | `2` | Multiplier applied to the backoff delay on each subsequent attempt. |
| `maxBackoffMs` | `number` | `5000` | Upper limit for the backoff delay. |
| `retryIf` | `(err) => boolean` | `() => true` | Predicate function. If it returns `false`, retrying stops immediately. |

---

## Overriding Retries per Invocation

When invoking tools programmatically, you can override or disable retries:

```typescript
// Disable retries for an idempotent check
const health = await app.callTool('execute_remote_sql', { query: 'SELECT 1' }, {
  retry: false
});

// Or customize attempts for a critical transaction
await app.callTool('execute_remote_sql', { query: 'COMMIT' }, {
  retry: { attempts: 5, backoffMs: 500 }
});
```

---

## Telemetry & Metrics

Every retry event is tracked in the telemetry pipeline:
- In `app.getAnalytics()`, each tool lists its total `retries` and `failedInvocations`.
- The Prometheus exporter emits `mcp_tool_retries_total` to track transient failure rates in Grafana dashboards.
