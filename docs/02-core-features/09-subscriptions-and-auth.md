---
title: Resource Subscriptions & Authentication
description: Real-time resource update notifications with client subscriptions (notifications/resources/updated) and HTTP Bearer Token / API Key protection.
---

# Resource Subscriptions & Authentication

Production MCP deployments require two essential real-time and security capabilities:
1. **Live Resource Subscriptions**: Letting AI clients (like Claude Desktop or Cursor) subscribe to resources and automatically re-fetch them whenever data changes on the server.
2. **HTTP Bearer Token & API Key Security**: Protecting HTTP and Streamable HTTP endpoints from unauthorized access in multi-user, team, or cloud environments.

**`mcponce`** provides turnkey, protocol-native implementations of both features.

---

## 🔔 Part 1: Resource Subscriptions & Live Updates

### How It Works

In the Model Context Protocol, clients advertise the `resources.subscribe` capability. When an AI client or user opens a resource, it can send a `resources/subscribe` request with the resource's URI.

When data changes on your server (e.g. after a database update, file change, or webhook), you call `app.notifyResourceUpdated(uri)`. `mcponce` automatically pushes a `notifications/resources/updated` notification to all subscribed client sessions:

```mermaid
sequenceDiagram
    participant Client as MCP Client (Claude / Cursor)
    participant Server as mcponce Server
    participant DB as Backend / Database

    Client->>Server: resources/subscribe { uri: "orders://ord-100" }
    Server-->>Client: {} (Acknowledged)
    Note over Client,Server: Client monitors resource...

    DB->>Server: Data updated (status: "shipped")
    Server->>Server: app.notifyResourceUpdated("orders://ord-100")
    Server->>Client: notifications/resources/updated { uri: "orders://ord-100" }
    Client->>Server: resources/read { uri: "orders://ord-100" }
    Server-->>Client: Updated resource contents
```

---

### Quick Example: Live Order Tracking

```typescript
import { createMcpServer } from 'mcponce';

const app = createMcpServer({ name: 'order-tracker' });

// In-memory store
const orders = new Map<string, { status: string; updatedAt: string }>();

// 1. Expose parametric resource
app.resourceTemplate({
  uriTemplate: 'orders://{orderId}/status',
  name: 'order_status',
  handler: (uri, { orderId }) => {
    const order = orders.get(orderId) || { status: 'not_found', updatedAt: new Date().toISOString() };
    return { orderId, ...order };
  }
});

// 2. Tool that mutates data and triggers live notifications
app.tool({
  name: 'update_order_status',
  description: 'Updates the fulfillment status of an order and pushes live updates to subscribers',
  inputSchema: {
    orderId: 'string',
    status: 'string'
  },
  handler: async ({ orderId, status }) => {
    orders.set(orderId, { status, updatedAt: new Date().toISOString() });

    // Push live notification to any subscribed client session!
    const uri = `orders://${orderId}/status`;
    const notifiedSessions = await app.notifyResourceUpdated(uri);

    return { success: true, notifiedSessions };
  }
});

app.run();
```

---

### Server Methods for Subscriptions

#### `app.notifyResourceUpdated(uri: string | URL): Promise<number>`
Broadcasts a `notifications/resources/updated` event with the given URI to all connected sessions subscribed to that URI (or to all active sessions if no explicit subscriptions exist). Returns the number of sessions notified.

```typescript
await app.notifyResourceUpdated('system://analytics');
```

#### `app.notifyResourceListChanged(): Promise<number>`
Broadcasts a `notifications/resources/list_changed` event to all connected sessions, prompting clients to re-query `resources/list` or `resources/templates/list`.

```typescript
await app.notifyResourceListChanged();
```

#### `app.onResourceUpdated(listener: (uri: string) => void): () => void`
Attaches an internal server-side listener that fires whenever `notifyResourceUpdated` is called. Returns an unsubscribe function.

```typescript
const unsubscribe = app.onResourceUpdated((uri) => {
  console.log(`Resource changed: ${uri}`);
});
```

#### `app.getSubscribedResources(sessionId?: string): string[]`
Returns an array of all active subscribed resource URIs across all sessions or for a specific session.

---

## 🔒 Part 2: HTTP Bearer Token & API Key Authentication

When exposing an MCP server over HTTP or deploying to a cloud host (AWS, Fly.io, Railway, Kubernetes), securing endpoints is critical.

`mcponce` allows securing your server with a single configuration property or environment variable.

### Configuration

You can provide a single key, an array of allowed keys, or configure via environment variables:

:::tabs group="auth-config"
::tab Single Key in Code
```typescript
import { createMcpServer } from 'mcponce';

const app = createMcpServer({
  name: 'secure-server',
  apiKey: 'prod-secret-token-987654'
});

app.run();
```
::tab Multiple Keys (Team / Multi-Client)
```typescript
const app = createMcpServer({
  name: 'secure-server',
  apiKey: [
    'client-claude-key-aaa',
    'client-cursor-key-bbb',
    'admin-key-ccc'
  ]
});
```
::tab Environment Variable (Zero Code Changes)
```bash
# Set via environment variable before launching
export MCPONCE_API_KEY="prod-secret-token-987654"
# Multiple comma-separated keys are also supported:
# export MCPONCE_API_KEY="key-1,key-2,key-3"

node server.js
```
:::

---

### How Authentication Works

When `apiKey` is set, `mcponce` applies an authentication middleware across all endpoints:

| Endpoint | Auth Required? | Notes |
| :--- | :---: | :--- |
| `GET /health` | **No (Public)** | Kept open for health checks, load balancers, and Docker/K8s liveness probes. |
| `POST /mcp` | **Yes** | Streamable HTTP JSON-RPC endpoint. |
| `GET /analytics` | **Yes** | Telemetry and call graph dashboard data. |
| `GET /info` | **Yes** | Process and server information. |
| `GET /metrics` | **Yes** | Prometheus metrics endpoint. |

### Sending Credentials

Clients can supply credentials in any of the following standard formats:

1. **Authorization Header (Standard Bearer)**:
   ```http
   Authorization: Bearer prod-secret-token-987654
   ```
2. **X-API-Key Header**:
   ```http
   X-API-Key: prod-secret-token-987654
   ```
3. **URL Query Parameter**:
   ```http
   GET /analytics?api_key=prod-secret-token-987654
   ```

If credentials are missing or invalid, `mcponce` responds immediately with **HTTP 401 Unauthorized**:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Unauthorized: Invalid or missing API key. Provide Authorization: Bearer <key> or X-API-Key: <key>"
  },
  "id": null
}
```

---

## 💡 Best Practices

1. **Always keep `/health` public**: Automated orchestrators (AWS ECS, Kubernetes, Cloud Run) rely on unauthenticated health checks to determine container readiness.
2. **Combine with Dynamic Port Allocation**: Running with `port: 0` and `apiKey` provides zero-collision security suitable for local shared daemons and containerized environments.
3. **Use granular keys for multi-client setups**: Pass an array of keys (`['cursor-key', 'claude-key']`) so individual tokens can be revoked or rotated independently.
4. **Notify subscribers selectively**: Calling `app.notifyResourceUpdated` only notifies sessions that have registered interest via `resources/subscribe`, avoiding unnecessary client re-fetching overhead.
