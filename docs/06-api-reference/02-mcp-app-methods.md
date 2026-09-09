---
title: McpApp Methods
description: Comprehensive method reference for the McpApp server instance including tool, resource, prompt, and execution APIs.
---

# `McpApp` Methods

The `McpApp` instance is returned by `createMcpServer(...)` and manages the server lifecycle, tool registrations, middleware pipeline, and protocol transports.

---

## Tool Registration & Management

### `app.tool(definition)`
Registers a new tool on the server. Returns `this` for chaining.

```typescript
app.tool({
  name: 'my_tool',
  description: 'Does something useful',
  inputSchema: { query: { type: 'string', required: true } },
  handler: async ({ query }) => ({ result: query })
});
```

### `app.getTools()`
Returns an array of all registered tools with their normalized metadata.

```typescript
const tools = app.getTools();
console.log(`Registered ${tools.length} tools`);
```

### `app.getTool(name)`
Retrieves the definition of a specific tool by name, or `undefined` if not registered.

```typescript
const tool = app.getTool('my_tool');
```

---

## Programmatic Invocation

### `app.callTool(name, args?, options?)`
Invokes a tool programmatically with validation, coercion, caching, and retry mechanics.

```typescript
const result = await app.callTool('my_tool', { query: 'hello' }, {
  timeoutMs: 5000,
  noCache: true,
  onProgress: (p) => console.log(p.message)
});

console.log(result.data); // Typed response data
console.log(result.text); // Formatted string representation
```

---

## Middleware & Interceptors

### `app.use(handler)`
Registers a global middleware executed for every tool call.

```typescript
app.use(async (ctx, next) => {
  console.log(`Executing ${ctx.tool}`);
  return next();
});
```

### `app.use(filter, handler)`
Registers a targeted middleware matching specific tool names, array of names, or regular expressions.

```typescript
app.use(/^admin_/, async (ctx, next) => {
  // Only runs for tools starting with admin_
  return next();
});
```

---

## Resources & Prompts

### `app.resource(definition)`
Registers an MCP resource accessible via URI.

```typescript
app.resource({
  uri: 'file:///config.json',
  name: 'App Configuration',
  mimeType: 'application/json',
  handler: async () => ({
    contents: [{ uri: 'file:///config.json', text: '{"env": "production"}' }]
  })
});
```

### `app.prompt(definition)`
Registers a reusable prompt template for AI models.

```typescript
app.prompt({
  name: 'review_code',
  description: 'Code review assistant prompt',
  arguments: [{ name: 'language', required: true }],
  handler: ({ language }) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `Review this ${language} code` } }
    ]
  })
});
```

---

## Observability & Cache APIs

### `app.getAnalytics()`
Returns a complete snapshot of `ServerAnalytics` including totals, durations, tool metrics, and call graphs.

### `app.getMetrics()`
Returns Prometheus 0.0.4 text format metrics for scraping.

### `app.resetAnalytics()`
Resets telemetry counters and ring buffers.

### `app.clearCache(toolName?)`
Clears cached responses. If `toolName` is passed, invalidates only that tool. If omitted, clears all tools. Returns count of evicted entries.

### `app.getCacheStats()`
Returns `{ size, hits, misses, evictions }`.

### `app.getQueueStats()`
Returns active queue lengths and active concurrency counts across mutex keys.

### `app.readLogs(limit?)`
Returns the last `limit` lines from the structured log file (default: 100).

---

## Lifecycle & Runtime

### `app.run()`
Primary entrypoint for your CLI script (`process.argv`). Automatically handles CLI subcommands (`list`, `call`, `status`, `logs`), sets up single-instance coordination, and boots stdio or HTTP.

```typescript
app.run().catch(console.error);
```

### `app.start(options?)`
Programmatically starts the Streamable HTTP server. If another instance is already running, bridges to it seamlessly.

### `app.stop(options?)`
Performs a graceful shutdown, aborts in-flight tools, unlinks sockets, and cleans locks.

### `app.restart(options?)`
Stops the server, waits for port release, and restarts.

### `app.status()`
Returns the current `ServerStatus` (`'running'` or `'stopped'`, PID, port, sessions).
