---
title: Timeout & Cancellation
description: Cooperative AbortSignal integration, uncooperative hard deadlines, and client cancellation handling.
---

# Timeout & Cancellation

AI agents frequently trigger network requests, database transactions, or external operations that might stall or take too long. Without robust timeout and cancellation systems:
1. Server worker threads become blocked indefinitely.
2. Users cancelling a query in Claude or Cursor leave dangling zombie processes behind.

**mcponce** provides a dual-layer deadline management system combining **cooperative cancellation** via standard web `AbortSignal` with **uncooperative hard deadlines**.

---

## Configuring Deadlines

Timeouts can be configured globally, per-tool, or dynamically on individual invocations:

:::tabs group="timeout-config"
::tab Per-Tool Timeout
```typescript
app.tool({
  name: 'scrape_webpage',
  description: 'Fetches HTML with 5s timeout',
  timeoutMs: 5000, // 5 seconds deadline for this tool
  handler: async ({ url }, context) => {
    // Pass context.signal to cooperative APIs
    const response = await fetch(url, { signal: context.signal });
    return response.text();
  }
});
```

::tab Global Server Timeout
```typescript
const app = createMcpServer({
  name: 'api-service',
  toolTimeoutMs: 30000 // Default 30s timeout across all tools
});
```

::tab Invocation Timeout
```typescript
// Custom timeout for a programmatic call
await app.callTool('scrape_webpage', { url: 'https://example.com' }, {
  timeoutMs: 2000
});
```
:::

:::tip Disabling Timeouts
Set `timeoutMs: 0` on a tool to allow it to run indefinitely (useful for long-running backup jobs, ML inference, or daemon tasks).
:::

---

## Cooperative Cancellation (`AbortSignal`)

Every tool handler receives `context.signal` (and `extra.signal`), an instance of the standard web [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal).

### Using `context.signal` with Native APIs
Pass `context.signal` directly to standard libraries such as `fetch`, `node:fs`, `node:child_process`, or database drivers:

```typescript
app.tool({
  name: 'query_remote_database',
  handler: async ({ query }, context) => {
    // 1. Pass signal directly to fetch or database queries
    const res = await fetch('https://api.db.com/query', {
      method: 'POST',
      body: JSON.stringify({ query }),
      signal: context.signal
    });

    return res.json();
  }
});
```

### Checking `signal.aborted` in Loops
For CPU-bound loops or iterative jobs, periodically check `signal.aborted`:

```typescript
app.tool({
  name: 'train_iteration',
  handler: async ({ epochs }, context) => {
    for (let i = 0; i < epochs; i++) {
      // Check if client cancelled or timeout fired
      if (context.signal?.aborted) {
        throw new Error('Operation aborted by client or deadline');
      }

      await computeStep(i);
    }
  }
});
```

---

## Uncooperative Hard Deadlines

What if a third-party library hangs and completely ignores `context.signal`?

`mcponce` ensures your server never blocks. When a deadline expires:
1. `context.signal` is immediately aborted (`signal.aborted === true`).
2. The invocation promise is rejected with a descriptive timeout error.
3. The server slot is freed in the concurrency queue, allowing subsequent tool calls to proceed without starvation.

---

## Client Cancellation (`notifications/cancelled`)

When an end-user presses **Stop Generation** in Claude Desktop or Cursor:
1. The MCP client sends a `notifications/cancelled` notification containing the `requestId`.
2. `mcponce` instantly matches the active request and triggers the corresponding `AbortController`.
3. Running HTTP requests, child processes, or database queries listening to `context.signal` are terminated immediately, saving compute and bandwidth.
