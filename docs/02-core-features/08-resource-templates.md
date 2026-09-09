---
title: Dynamic Resource URI Templates
description: Parametric resources matching dynamic RFC 6570 URI patterns with parameter extraction, autocompletion callbacks, and automatic return normalization.
---

# Dynamic Resource URI Templates (RFC 6570)

In the Model Context Protocol (MCP), **Resources** allow servers to expose contextual data (such as files, database records, API responses, or system metrics) to AI agents and users.

While static resources have fixed URIs (e.g. `system://metrics` or `docs://cheatsheet`), real-world applications frequently require **parametric, dynamic resources**—such as reading a specific user profile (`users://{userId}/profile`), inspecting a repository issue (`repos://{owner}/{repo}/issues/{id}`), or fetching an audit log for a given date (`logs://{service}/{date}`).

**`mcponce`** provides full, native support for **RFC 6570 URI Templates**, providing automated variable extraction, autocompletion handlers, and flexible return normalization.

---

## 🚀 Quick Example

```typescript
import { createMcpServer } from 'mcponce';

const app = createMcpServer({ name: 'store-server' });

// Register a parametric resource template
app.resourceTemplate({
  uriTemplate: 'users://{userId}/profile',
  name: 'user_profile',
  description: 'Fetches the user profile for a given user ID',
  mimeType: 'application/json',
  complete: {
    // Autocompletion handler for the {userId} variable in AI clients
    userId: async (prefix) => {
      const candidates = ['usr-alice', 'usr-bob', 'usr-charlie'];
      return candidates.filter((id) => id.startsWith(prefix));
    }
  },
  handler: async (uri, params) => {
    // params contains extracted variables: { userId: 'usr-alice' }
    return {
      userId: params.userId,
      role: 'admin',
      profileUrl: uri.href,
      lastLogin: new Date().toISOString()
    };
  }
});

app.run();
```

---

## 📋 Registration Syntax

`mcponce` provides multiple ergonomic ways to register resource templates:

### 1. Dedicated `app.resourceTemplate(...)`

The explicit and recommended method:

```typescript
app.resourceTemplate({
  uriTemplate: 'orders://{orderId}/items/{itemId}',
  name: 'order_item',
  description: 'Details of a specific line item in an order',
  handler: (uri, { orderId, itemId }) => {
    return fetchOrderItem(orderId, itemId);
  }
});
```

### 2. Auto-Detection via `app.resource(...)`

If you pass a URI pattern containing `{` and `}` braces to `app.resource(...)`, `mcponce` automatically identifies it as a dynamic resource template:

```typescript
// Automatically registered as a dynamic template because uri has template braces!
app.resource({
  uri: 'memos://{category}/{id}',
  name: 'category_memo',
  handler: (uri, params) => {
    return `# Memo: ${params.id}\nCategory: ${params.category}`;
  }
});
```

---

## 🛠️ Configuration Options

| Option | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `uriTemplate` | `string` | **Yes** | Standard RFC 6570 URI template (e.g. `app://{module}/{id}`). |
| `name` | `string` | No | Identifier or title for the template. Defaults to `uriTemplate`. |
| `description`| `string` | No | Human-readable description presented to AI clients in template lists. |
| `mimeType` | `string` | No | Default MIME type for generated content (e.g. `application/json`, `text/markdown`). |
| `complete` | `Record<string, (val: string) => Promise<string[]> \| string[]>` | No | Autocomplete functions for template variables. |
| `list` | `(context) => Promise<Resource[]> \| Resource[]` | No | Callback enumerating known concrete resources matching this template. |
| `handler` | `(uri, params, context) => Promise<any> \| any` | **Yes** | Handler invoked when a client reads a matching resource URI. |

---

## 🧩 Variable Extraction

When an MCP client (or programmatic caller) requests a resource matching your template, `mcponce` extracts all template variables and passes them as a key-value dictionary in the second argument:

```typescript
app.resourceTemplate({
  uriTemplate: 'github://{owner}/{repo}/commits/{sha}',
  handler: async (uri, params, context) => {
    console.log(params.owner); // 'facebook'
    console.log(params.repo);  // 'react'
    console.log(params.sha);   // 'main'
    console.log(uri.href);     // 'github://facebook/react/commits/main'

    return await fetchCommit(params.owner, params.repo, params.sha);
  }
});
```

---

## 🔄 Automatic Return Normalization

In raw MCP, resource handlers must return a rigid `{ contents: [{ uri, mimeType, text, blob }] }` structure.

In `mcponce`, resource handlers can return any data format—`mcponce` automatically normalizes it into a compliant MCP response:

:::tabs group="returns"
::tab Plain Objects & JSON
```typescript
app.resourceTemplate({
  uriTemplate: 'users://{id}',
  handler: (uri, { id }) => ({ id, name: 'Alice', active: true })
  // -> Serialized to JSON string with mimeType 'application/json'
});
```
::tab Plain Strings & Markdown
```typescript
app.resourceTemplate({
  uriTemplate: 'docs://{topic}',
  mimeType: 'text/markdown',
  handler: (uri, { topic }) => `# Documentation for ${topic}\n\nContent...`
  // -> Wrapped in TextResourceContents with mimeType 'text/markdown'
});
```
::tab Binary Buffers & Files
```typescript
import fs from 'node:fs/promises';

app.resourceTemplate({
  uriTemplate: 'reports://{year}/{month}.pdf',
  mimeType: 'application/pdf',
  handler: async (uri, { year, month }) => {
    return await fs.readFile(`./reports/${year}-${month}.pdf`);
    // -> Automatically base64 encoded into BlobResourceContents
  }
});
```
::tab Raw ReadResourceResult
```typescript
app.resourceTemplate({
  uriTemplate: 'custom://{id}',
  handler: (uri, { id }) => ({
    contents: [
      { uri: uri.href, mimeType: 'text/plain', text: `Item ${id}` }
    ]
  })
});
```
:::

---

## 🔍 Autocompletion Handlers

Clients like Claude Desktop and Cursor query the MCP server's completion endpoint (`completion/complete`) when a user or model is typing a resource URI.

You can attach completion handlers directly to your resource template:

```typescript
app.resourceTemplate({
  uriTemplate: 'database://{table}/{rowId}',
  complete: {
    table: async (query) => {
      const tables = ['users', 'orders', 'products', 'invoices'];
      return tables.filter((t) => t.startsWith(query));
    },
    rowId: async (query, context) => {
      // You can access previously entered arguments:
      const selectedTable = context?.arguments?.table;
      return await searchRowIds(selectedTable, query);
    }
  },
  handler: async (uri, { table, rowId }) => {
    return await db.query(table, rowId);
  }
});
```

---

## 🧪 Programmatic Reading (`app.readResource`)

You can read resources programmatically inside tests, scripts, or other tools without connecting an external MCP client:

```typescript
// Read a static resource
const metrics = await app.readResource('system://metrics');

// Read a dynamic resource template (matches pattern & extracts params)
const userProfile = await app.readResource('users://usr-123/profile');

console.log(userProfile.contents[0].text);
```

If a resource or matching template is not found, `app.readResource` throws a clear `Error('Resource not found: ...')`.

You can also inspect matches directly:

```typescript
const match = app.matchResourceTemplate('users://usr-456/profile');
if (match) {
  console.log('Matched Template:', match.template.name);
  console.log('Extracted Params:', match.params); // { userId: 'usr-456' }
}
```

---

## 💡 Best Practices

1. **Use clear URI schemes**: Define distinct schemes for your resources (e.g. `users://`, `docs://`, `db://`) rather than mixing everything under generic protocols.
2. **Set `mimeType`**: Always define an explicit `mimeType` (e.g. `application/json`, `text/markdown`, `image/png`) to give AI models clear context on how to interpret the payload.
3. **Add `complete` callbacks for discoverability**: Supplying autocompletion callbacks helps both LLMs and human users discover valid parameters without guesswork.
4. **Leverage Return Normalization**: Return clean domain objects or strings directly from your handlers rather than manually constructing MCP contents objects.
