---
title: Smart Input Coercion & Schema Defaults
description: How mcponce prevents tool execution errors by intelligently coercing stringified numbers, booleans, and JSON arguments.
---

# Smart Input Coercion & Schema Defaults

LLMs frequently serialize arguments as strings when calling tools (for instance sending `{"limit": "10", "active": "true"}` instead of native types `{"limit": 10, "active": true}`). Furthermore, command-line arguments are always parsed as strings.

In vanilla MCP servers, this causes immediate schema validation failures. In `mcponce`, **Smart Input Coercion** seamlessly maps and sanitizes incoming data before your handler executes.

---

## ⚡ Enabling Coercion

You can enable smart coercion at the server level, tool level, or per invocation:

### 1. Server-Wide (Recommended)

```ts
const app = createMcpServer({
  name: 'my-server',
  coerceInputs: true // Automatically coerces inputs across all tools
});
```

### 2. Per-Tool

```ts
app.tool({
  name: 'resize_image',
  coerceInputs: true,
  inputSchema: {
    width: 'number',
    height: 'number',
    preserveAspect: { type: 'boolean', default: true }
  },
  handler: ({ width, height, preserveAspect }) => {
    // width is guaranteed to be a native number, preserveAspect is boolean
    console.log(typeof width); // 'number'
    console.log(typeof preserveAspect); // 'boolean'
  }
});
```

---

## 🔄 Supported Coercion Rules

| Target Type | Input Value | Coerced Output |
| :--- | :--- | :--- |
| **Number** | `"42"`, `"3.14"`, `"-100"` | `42`, `3.14`, `-100` |
| **Boolean** | `"true"`, `"1"`, `"yes"`, `"on"` | `true` |
| **Boolean** | `"false"`, `"0"`, `"no"`, `"off"` | `false` |
| **Array** | `"[1, 2, 3]"` | `[1, 2, 3]` |
| **Array** | `"apple,banana,cherry"` | `["apple", "banana", "cherry"]` |
| **Object** | `'{"key": "val"}'` | `{ key: "val" }` |
| **String** | `12345` | `"12345"` |

---

## 🎯 Default Value Population

When an argument is omitted by the caller, `mcponce` automatically populates the configured default values:

```ts
app.tool({
  name: 'fetch_logs',
  inputSchema: {
    service: 'string',
    limit: { type: 'number', default: 50 },
    includeDebug: { type: 'boolean', default: false }
  },
  handler: ({ service, limit, includeDebug }) => {
    return { service, limit, includeDebug };
  }
});

// Calling without optional parameters:
const res = await app.callTool('fetch_logs', { service: 'auth-api' });
console.log(res.data);
// { service: "auth-api", limit: 50, includeDebug: false }
```

---

## 🚀 Performance: 800,000+ Ops / sec

In our Vitest Tinybench benchmarks:
- **`smartCoerceValue & coerceArguments`**: **803,346 ops/sec** (~1.2 µs).
- Pre-compiled Zod schemas ensure coercion is evaluated without reconstructing Zod validator trees.

---

## Next Steps

- Explore **[In-Memory Caching](/core-features/in-memory-caching)**.
- Learn about **[Middleware Interceptors](/core-features/middleware-interceptors)**.
