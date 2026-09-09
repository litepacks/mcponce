---
title: Architecture & Internal Runtime
description: Deep dive into the architecture of mcponce, from Hono HTTP routing and pre-compiled schemas to Unitup background coordination.
---

# Architecture & Internal Runtime

`mcponce` is engineered with a layered, decoupled architecture designed for high throughput, sub-microsecond internal scheduling, and seamless background process coordination.

---

## 🏛️ System Architecture Diagram

```mermaid
graph TD
    subgraph Client Layer
        LLM["AI Client (Claude / Cursor)"]
        CLI["CLI Caller (mcponce call)"]
        Prom["Prometheus / Scraper"]
    end

    subgraph mcponce Instance
        Hono["Hono Web Framework (Fast HTTP & Middleware)"]
        
        subgraph Endpoints
            MCP["POST /mcp (JSON-RPC & SSE)"]
            Health["GET /health"]
            Info["GET /info"]
            Analytics["GET /analytics"]
            Metrics["GET /metrics"]
        end

        Hono --> Endpoints

        subgraph Core Execution Engine
            MW["Middleware Chain (Onion Interceptors)"]
            Zod["Pre-Compiled Zod Schema Parser"]
            Cache["ToolCacheManager (LRU + TTL)"]
            Queue["QueueManager (FIFO Concurrency Mutex)"]
            Handler["Tool Handler Execution"]
            Progress["ProgressReporter (MCP Stream)"]
        end

        MCP --> MW
        CLI --> MW
        MW --> Zod
        Zod --> Cache
        Cache -->|Hit (5.5k ops/s)| FastReturn["Instant Cached Return"]
        Cache -->|Miss| Queue --> Handler
        Handler --> Progress
        Handler -.->|callTool| Handler

        subgraph State & Coordination
            Unitup["Unitup Background Daemon"]
            Lock["File Lock & PID State Manager"]
            Reg["Central Multi-App Registry"]
            Tele["AnalyticsCollector (Telemetry & Prometheus)"]
        end

        Handler --> Tele
        Hono --> Lock
        Lock --> Unitup
        Lock --> Reg
    end

    LLM -->|Streamable HTTP| MCP
    Prom -->|Scrape| Metrics
```

---

## 🧩 Architectural Layers

### 1. Transport & HTTP Layer ([Hono](https://hono.dev/))
Unlike traditional MCP servers that only speak stdio, `mcponce` is built on Hono:
- **Streamable HTTP**: Uses `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`.
- **CORS Support**: Permissive headers by default so web-based agents and local browser tools can connect without proxy servers.
- **REST Diagnostics**: Built-in `/health`, `/info`, `/analytics`, and `/metrics` routes live alongside `/mcp`.

### 2. Zero-Allocation Schema & Execution Engine
To maximize throughput:
- **Pre-compiled Zod Schemas**: When you register a tool with `app.tool(...)`, `mcponce` generates both a standard Zod schema and a coerced Zod schema **once**. During execution, schemas are never re-evaluated or re-allocated.
- **Early Cache Lookup**: When a tool has caching enabled, `ToolCacheManager.get` evaluates immediately after argument validation. If hit, the response returns in **~0.18 ms** without creating timers or `AbortController` instances.
- **Microsecond Concurrency Queues**: The internal `ConcurrencyQueue` operates via native promise resolvers, allowing **1,800,000+ mutex acquisitions per second**.

### 3. Background Process Coordination ([Unitup](https://github.com/litepacks/unitup))
When running with `--background`:
1. **Lockfile Negotiation**: The server uses atomic filesystem lockfiles (`lockfile`) in the platform-specific data directory (`~/.local/share/mcponce` on Linux, `~/Library/Application Support/mcponce` on macOS, `%LOCALAPPDATA%/mcponce` on Windows).
2. **Owner vs Bridge**:
   - The first client process to launch becomes the **Daemon Owner** (managed via Unitup).
   - Subsequent client processes detect the live PID, verify health over `/health`, and function as a lightweight **Bridge**, connecting to the existing background server.
3. **Stale State Auto-Recovery**: If a server process terminates abruptly (power loss, SIGKILL), subsequent starts inspect `/health`, detect the dead PID, clean up orphaned socket/port metadata, and seamlessly restart.

### 4. Multi-Application Central Registry
Multiple distinct `mcponce` applications (e.g. `browsertrack`, `softscope`, `recallite`) can run simultaneously on the same machine. Each application is tracked in the Central Registry with unique ports, data directories, and lifecycle metadata.

---

## Next Steps

- Explore **[Defining Tools & Schemas](/core-features/defining-tools)**.
- Understand **[Concurrency & Queues](/reliability/concurrency-and-queues)**.
- Learn about **[Streamable HTTP Transport](/runtime-and-cli/streamable-http)**.
