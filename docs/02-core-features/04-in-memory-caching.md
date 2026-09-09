---
title: In-Memory Caching
description: High-throughput LRU response caching with automatic serialization, custom keys, and instant eviction.
---

# In-Memory Caching

When an AI model executes repeated analytical tasks, database queries, or expensive computations with identical arguments, re-running the handler wastes resources and adds latency. 

**mcponce** provides a zero-dependency, ultra-fast in-memory **LRU (Least Recently Used) cache** built directly into the tool execution lifecycle, achieving over **5,500 operations per second** on cache hits with near-instant sub-millisecond response times.

---

## Quick Configuration

Enable caching on any tool by passing `cache: true` or providing a detailed `ToolCacheConfig` object:

:::tabs group="cache-config"
::tab Basic (Boolean)
```typescript
app.tool({
  name: 'get_exchange_rates',
  description: 'Fetches currency exchange rates from foreign API',
  inputSchema: {
    base: { type: 'string', default: 'USD' }
  },
  // Automatically caches up to 100 entries for 60 seconds
  cache: true,
  handler: async ({ base }) => {
    const res = await fetch(`https://api.exchangerate.host/latest?base=${base}`);
    return res.json();
  }
});
```

::tab Advanced (Object)
```typescript
app.tool({
  name: 'query_vector_db',
  description: 'Performs semantic vector search',
  inputSchema: {
    vector: { type: 'array', required: true },
    namespace: { type: 'string', default: 'default' },
    topK: { type: 'number', default: 10 }
  },
  cache: {
    ttlMs: 300_000,      // Keep entries for 5 minutes
    maxSize: 500,        // Retain up to 500 unique entries before LRU eviction
    keyGenerator: (args) => `${args.namespace}:${args.topK}:${JSON.stringify(args.vector)}`
  },
  handler: async (args) => {
    return runVectorSearch(args);
  }
});
```
:::

---

## Configuration Options

The `cache` option accepts either a boolean or `ToolCacheConfig`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `cache` | `boolean \| ToolCacheConfig` | `false` | Enables response caching when set to `true` or an object. |
| `ttlMs` | `number` | `60000` (1m) | Time-to-live in milliseconds before a cached item expires. |
| `maxSize` | `number` | `100` | Maximum number of entries. Oldest entries are evicted first. |
| `keyGenerator` | `(args) => string` | `undefined` | Custom hashing function. If omitted, args are recursively sorted and serialized. |

:::note Deterministic Default Keys
When `keyGenerator` is omitted, `mcponce` uses a fast, recursive canonical serializer that alphabetizes dictionary keys. `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` generate identical cache keys.
:::

---

## Cache Invalidation & Eviction

### 1. Invalidation via Tool Context
Every tool handler receives `context.clearCache(toolName?)` to evict cached data upon write or update operations:

```typescript
app.tool({
  name: 'update_customer_status',
  description: 'Updates a customer and invalidates their cached profile',
  inputSchema: {
    customerId: { type: 'string', required: true },
    status: { type: 'string', required: true }
  },
  handler: async ({ customerId, status }, context) => {
    await db.customers.update({ id: customerId }, { status });

    // Evicts cached entries for 'get_customer_profile'
    const evictedCount = context.clearCache('get_customer_profile');

    return { 
      success: true, 
      invalidatedEntries: evictedCount 
    };
  }
});
```

:::tip Clearing All Caches
Calling `context.clearCache()` without arguments clears all cached responses across every registered tool.
:::

### 2. Programmatic Invalidation
You can clear cache entries at any time via the main `app` instance:

```typescript
// Clear specific tool cache
const evicted = app.clearCache('query_vector_db');

// Clear all tool caches
const totalEvicted = app.clearCache();
```

---

## Bypassing Cache per Invocation

Callers can bypass the cache and force a fresh execution using options or CLI flags:

:::tabs group="cache-bypass"
::tab Programmatic Call
```typescript
// Bypass cache for a single programmatic call
const result = await app.callTool('get_exchange_rates', { base: 'USD' }, {
  noCache: true // or bypassCache: true
});
```

::tab Inter-Tool Call
```typescript
app.tool({
  name: 'sync_pipeline',
  handler: async (_, context) => {
    // Force fresh data fetching inside inter-tool call
    return context.callTool('get_exchange_rates', { base: 'EUR' }, {
      noCache: true
    });
  }
});
```

::tab Terminal CLI
```bash
# Force fresh execution via CLI flag
npx mcponce call get_exchange_rates --base=USD --no-cache
```
:::

---

## Telemetry & Cache Statistics

`mcponce` tracks detailed cache metrics automatically. View them via:
- The [Prometheus Metrics](/observability/prometheus-metrics) endpoint (`/metrics`)
- The [Telemetry & Analytics](/observability/telemetry-and-analytics) engine (`app.getAnalytics()`)

```typescript
const analytics = app.getAnalytics();

console.log(analytics.summary.cachedInvocations); // Total cache hits
console.log(analytics.tools['get_exchange_rates'].cacheHits);
```
