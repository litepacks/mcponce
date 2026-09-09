---
title: Inter-Tool Calling (Tools Calling Tools)
description: How to compose tools hierarchically with automatic cycle detection, depth protection, and telemetry tracking in mcponce.
---

# Inter-Tool Calling

In real-world MCP servers, complex operations often require combining multiple smaller tools.

Rather than duplicating logic across handlers or relying on LLM round-trips to chain tools, `mcponce` provides first-class **inter-tool calling** with full argument validation, automatic cycle detection, and call graph telemetry.

---

## 🔗 How It Works

Every tool handler receives a second argument `context` containing `callTool`:

```ts
app.tool({
  name: 'add',
  inputSchema: { a: 'number', b: 'number' },
  handler: ({ a, b }) => ({ sum: a + b })
});

app.tool({
  name: 'multiply',
  inputSchema: { a: 'number', b: 'number' },
  handler: ({ a, b }) => ({ product: a * b })
});

app.tool({
  name: 'calculate_tax_and_total',
  inputSchema: { subtotal: 'number', taxRatePercent: 'number' },
  handler: async ({ subtotal, taxRatePercent }, { callTool }) => {
    // 1. Calculate tax using 'multiply'
    const taxRes = await callTool('multiply', {
      a: subtotal,
      b: taxRatePercent / 100
    });
    const tax = taxRes.data.product;

    // 2. Add tax to subtotal using 'add'
    const totalRes = await callTool('add', { a: subtotal, b: tax });
    const total = totalRes.data.sum;

    return { subtotal, tax, total };
  }
});
```

---

## 🛡️ Built-in Safety & Protections

### 1. Automatic Cycle Detection
If Tool A calls Tool B, and Tool B accidentally calls Tool A, `mcponce` intercepts the invocation immediately and throws a descriptive error:

```
Error: Circular tool invocation detected: tool_a -> tool_b -> tool_a
```

### 2. Maximum Call Depth (Recursion Guard)
To protect against infinite deep chains, invocations are capped at a maximum depth of 20 stack frames:

```
Error: Maximum tool call depth exceeded (20): t1 -> t2 -> ... -> t20
```

### 3. Automatic AbortSignal Propagation
When an outer tool call is cancelled (e.g. client disconnects or outer timeout triggers), the `signal` automatically cascades down to all inner tool calls.

---

## 📊 Inter-Tool Telemetry & Call Graphs

Every inter-tool call is automatically recorded in the server's telemetry engine:

```ts
const analytics = app.getAnalytics();
console.log(analytics.interToolCalls);
// [
//   { caller: "calculate_tax_and_total", target: "multiply", count: 12 },
//   { caller: "calculate_tax_and_total", target: "add", count: 12 }
// ]
```

You can view the full ASCII call graph in the terminal:
```bash
node server.js analytics
```
Or scrape Prometheus counters:
```
mcp_inter_tool_calls_total{caller="calculate_tax_and_total",target="multiply"} 12
```

---

## 💻 Programmatic Invocation (`app.callTool`)

You can also call tools programmatically on the server instance directly from your own code or tests:

```ts
const result = await app.callTool('add', { a: 10, b: 20 });
console.log(result.data.sum); // 30
console.log(result.text);     // '{"sum":30}'
```

---

## Next Steps

- Explore **[Smart Input Coercion](/core-features/smart-input-coercion)**.
- Configure **[In-Memory Caching](/core-features/in-memory-caching)** for expensive tool outputs.
