---
title: Streamable HTTP Transport
description: High-performance Hono-powered Streamable HTTP and SSE transport for networked MCP deployments.
---

# Streamable HTTP Transport

While local stdio transports connect directly to desktop apps like Claude and Cursor, networked architectures, remote agents, and web applications require standard HTTP and Server-Sent Events (SSE).

**mcponce** comes with a built-in, lightning-fast **Hono-based Streamable HTTP server** supporting the latest MCP specifications.

---

## Starting an HTTP Server

Start the HTTP listener by specifying a `port` or calling `app.start()`:

```typescript
import { createMcpServer } from 'mcponce';

const app = createMcpServer({
  name: 'remote-weather-agent',
  port: 8080 // Listening port
});

app.tool({
  name: 'get_temperature',
  inputSchema: { city: { type: 'string', required: true } },
  handler: ({ city }) => ({ city, temperature: 24, unit: 'C' })
});

// Starts the HTTP server
await app.start();
console.log('HTTP Server listening on http://localhost:8080');
```

---

## Endpoints Overview

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/mcp` | `POST` | Primary MCP JSON-RPC protocol endpoint for tool invocations and requests. |
| `/mcp` | `GET` | Server-Sent Events (SSE) stream for real-time progress and notifications. |
| `/health` | `GET` | Health check endpoint returning server status, name, version, and uptime. |
| `/analytics` | `GET` | JSON snapshot of execution metrics, durations, and inter-tool relationships. |
| `/metrics` | `GET` | Standard Prometheus 0.0.4 metrics scrape endpoint. |

---

## Client Connection Examples

:::tabs group="http-clients"
::tab curl (Health Check)
```bash
curl http://localhost:8080/health
```
```json
{
  "status": "ok",
  "name": "remote-weather-agent",
  "version": "1.0.0",
  "uptime": 124.5
}
```

::tab curl (MCP Tool Call via JSON-RPC)
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_temperature",
      "arguments": { "city": "Istanbul" }
    }
  }'
```

::tab Server-Sent Events (SSE Stream)
```bash
curl -N http://localhost:8080/mcp
```
:::

---

## Multi-Session Management & CORS

- **CORS Enabled by Default:** Allows browser-based LLM frontends to communicate with local or remote servers without header configuration.
- **Session Tracking:** When clients provide the `mcp-session-id` header, `mcponce` tracks connection state and isolates notifications to that specific session.
- **Graceful Termination:** Closing an SSE connection immediately aborts any in-flight tools tied to that session via `context.signal`.
