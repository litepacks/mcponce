---
title: createMcpServer
description: Configuration options, constructor parameters, and environment variable overrides for createMcpServer.
---

# `createMcpServer`

The entry point for defining any `mcponce` server.

```typescript
import { createMcpServer } from 'mcponce';

const app = createMcpServer(options);
```

---

## Signatures

```typescript
function createMcpServer<TContext = unknown>(
  config: McpServerConfig<TContext> | string
): McpApp<TContext>;
```

If a string is provided, it is treated as `{ name: config }`:
```typescript
const app = createMcpServer('my-server');
```

---

## Configuration Options (`McpServerConfig`)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | **Required** | The unique identifier for this MCP server. |
| `version` | `string` | `'1.0.0'` | Semantic version reported to clients during handshake. |
| `host` | `string` | `'127.0.0.1'` | Host interface to bind when running HTTP. |
| `port` | `number` | `undefined` | Port number for Streamable HTTP server. |
| `dataDir` | `string` | `'~/.mcponce'` | Directory for lockfiles, logs, and registry state. |
| `logging` | `LoggingConfig` | `undefined` | Log rotation and retention settings. |
| `logger` | `Logger` | `undefined` | Custom logger adapter (e.g. Pino, Winston). |
| `context` | `() => TContext` | `undefined` | Async or sync factory creating the shared context. |
| `toolTimeoutMs` | `number` | `60000` (1m) | Global timeout in ms for tool execution (`0` disables). |
| `sequential` | `boolean` | `false` | If `true`, processes all tools on this server sequentially. |
| `maxConcurrency` | `number` | `undefined` | Upper limit of simultaneous tool executions server-wide. |
| `coerceInputs` | `boolean` | `false` | Automatically cast stringified arguments to schema types. |
| `background` | `boolean` | `false` | Starts this server as a detached Unitup background daemon. |
| `registerInCentral` | `boolean` | `true` | Registers server in `~/.mcponce/servers.json`. |
| `middleware` | `Array` | `[]` | Initial middleware pipeline handlers. |

---

## Environment Variables

| Variable | Description |
| :--- | :--- |
| `PORT` | Overrides the HTTP port specified in options. |
| `HOST` | Overrides the host interface (e.g. `0.0.0.0` for Docker). |
| `MCP_COERCE_INPUTS` | Set to `true` or `1` to enable smart input coercion globally. |
| `MCP_DISABLE_REGISTRY` | Set to `1` to prevent registering in central `servers.json`. |
| `MCP_DATA_DIR` | Custom directory path for all `mcponce` runtime files. |
