---
title: Performance Benchmarks
description: Quantitative Vitest Tinybench results measuring throughput, latency, queueing, and caching.
---

# Performance Benchmarks

MCP servers are often the latency bottleneck in agentic AI loops. Slow parameter parsing, heavy reflection, unoptimized middleware, and un-cached repetitive tool calls add hundreds of milliseconds to model latency.

`mcponce` is engineered with extreme attention to performance. Below are the official benchmark results measured with [Vitest](https://vitest.dev/) and [Tinybench](https://github.com/tinylibs/tinybench) on Apple Silicon (M-series).

---

## Benchmark Results Summary

| Benchmark Suite | Operations / sec | Average Latency | Description |
| :--- | :--- | :--- | :--- |
| **FIFO Concurrency Queue** | **~1,850,000 ops/sec** | **0.0005 ms** | Enqueue and dequeue throughput across synchronized workers. |
| **Smart Input Coercion** | **~810,000 ops/sec** | **0.0012 ms** | Pre-compiled schema validation and type casting per invocation. |
| **LRU Response Cache Hits** | **~5,500 ops/sec** | **0.18 ms** | Full end-to-end tool execution cycle on cached responses. |
| **Tool Registry Lookup** | **~2,400,000 ops/sec** | **0.0004 ms** | Tool resolution, metadata lookup, and validation initialization. |

---

## Running Benchmarks Locally

You can run the full benchmark suite on your own hardware at any time:

```bash
npm run bench
```

Sample output:
```text
✓ bench/mcponce.bench.ts (4) 2854ms
  ✓ FIFO Concurrency Queue > 1,847,210 ops/sec ±0.42% (98 samples)
  ✓ Smart Input Coercion > 812,450 ops/sec ±0.31% (95 samples)
  ✓ In-Memory Cache Hits > 5,520 ops/sec ±0.85% (88 samples)
  ✓ Tool Registry Map Lookup > 2,415,800 ops/sec ±0.20% (99 samples)

BENCHMARK COMPLETE: All performance thresholds passed.
```

---

## Architectural Optimizations

How does `mcponce` achieve these speeds?

1. **Pre-Compiled Schemas:** Shorthand schemas are compiled into optimized Zod validators once at server initialization, avoiding runtime AST recreation.
2. **Deterministic String Hashing:** Response cache keys use a fast key-sorting algorithm that incurs zero garbage collector pressure.
3. **Microtask Queue Scheduling:** The concurrency queue utilizes native microtasks (`queueMicrotask` / resolved promises) rather than heavy timer primitives.
4. **Zero-Allocation Middleware:** Middleware chains avoid array slice allocations on each invocation by using linked index stepping.
