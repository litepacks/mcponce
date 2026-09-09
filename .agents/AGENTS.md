# AGENTS.md — Developer & AI Agent Guide for Building MCP Servers with `mcponce`

> **Welcome, Agent.** This document is your authoritative reference for designing, implementing, testing, and shipping Model Context Protocol (MCP) servers using `mcponce`. Follow the architecture, patterns, and strict rules documented here to write reliable, enterprise-grade MCP servers.

---

## 1. Executive Summary & Mental Model

`mcponce` is a zero-boilerplate, high-performance, single-executable framework for TypeScript and JavaScript that implements the official Model Context Protocol (MCP) specification.

### Key Architectural Concepts
1. **Single-Executable Architecture**:
   A single file (`server.ts` or `index.js`) serves as:
   - The native MCP server (Streamable HTTP at `/mcp` & stdio JSON-RPC bridge for Claude Desktop / Cursor).
   - A built-in CLI for developers (`node server.js call <tool>`, `node server.js tools`, `node server.js analytics`).
   - A background daemon runner (integrated with Unitup / OS-level services).
   - An interactive Web Inspector UI (`/inspect`).
2. **Dual-Transport Bridge**:
   `mcponce` starts an HTTP server locally and transparently bridges `stdio` to it when launched by desktop clients (Claude, Cursor). Clients share a single background process instead of spawning dozens of redundant Node.js runtimes.
3. **Strict STDOUT Cleanliness (Rule #1 of MCP)**:
   When running over `stdio`, `process.stdout` is reserved **exclusively** for valid MCP JSON-RPC messages. Any arbitrary `console.log()` will corrupt the protocol stream and disconnect the client! Diagnostic messages must go to `logger` or `console.error`.

---

## 2. Quickstart: 30-Second MCP Server

### TypeScript Template (`server.ts`)
```ts
#!/usr/bin/env node
import { createMcpServer, z } from 'mcponce';

// 1. Initialize server
const app = createMcpServer({
  name: 'my-mcp-server',
  version: '1.0.0'
});

// 2. Register tools
app.tool({
  name: 'greet',
  description: 'Greet a user warmly with an optional custom title',
  inputSchema: {
    name: 'string',
    title: 'string?' // '?' denotes optional field
  },
  async handler({ name, title }) {
    const prefix = title ? `${title} ` : '';
    return `Hello, ${prefix}${name}!`; // Plain string return auto-normalizes into MCP CallToolResult
  }
});

// 3. Register tools using Zod (Full type safety)
app.tool({
  name: 'calculate_discount',
  description: 'Calculates the discounted price given base price and percentage',
  inputSchema: z.object({
    price: z.number().positive().describe('Original price in USD'),
    discountPercent: z.number().min(0).max(100).default(10).describe('Discount percentage')
  }),
  async handler({ price, discountPercent }) {
    const saved = (price * discountPercent) / 100;
    const finalPrice = price - saved;
    return {
      originalPrice: price,
      discountPercent,
      saved: Math.round(saved * 100) / 100,
      finalPrice: Math.round(finalPrice * 100) / 100
    }; // Plain object return auto-serializes to MCP JSON content
  }
});

// 4. Run server (handles stdio bridge, background daemon, and CLI automatically)
await app.run();
```

### JavaScript (ESM) Template (`index.js`)
```js
#!/usr/bin/env node
import { createMcpServer } from 'mcponce';

const app = createMcpServer('quick-server');

app.tool('echo', { message: 'string' }, async ({ message }) => {
  return `Echo: ${message}`;
});

await app.run();
```

---

## 3. Defining Tools

`mcponce` supports two syntax styles for defining tools:

### Style A: Object Configuration (`app.tool({ ... })`)
Recommended for production servers with caching, retry, timeout, or security requirements.

```ts
app.tool({
  name: 'fetch_user_profile',
  description: 'Retrieve a user profile from the database by ID or username',
  inputSchema: {
    userId: 'string?',
    username: 'string?'
  },
  timeoutMs: 5000,          // Tool-level timeout (default: 60000ms)
  cache: { ttlMs: 30000 },   // Cache responses for 30s
  retry: { maxRetries: 2 },  // Retry up to 2 times on transient failures
  async handler(args, context, extra) {
    // Tool implementation
  }
});
```

### Style B: Shorthand (`app.tool(name, schema, handler)`)
Great for concise tool definitions.

```ts
app.tool(
  'add',
  { a: 'number', b: 'number' },
  async ({ a, b }) => String(a + b)
);
```

### Input Schema Definition

`mcponce` offers three schema systems:

1. **Shorthand Schema Strings**:
   - Basic types: `'string'`, `'number'`, `'boolean'`, `'object'`, `'array'`
   - Optional fields: append `?` (e.g. `'string?'`, `'number?'`)
   - Detailed property definition:
     ```ts
     inputSchema: {
       limit: {
         type: 'number',
         required: false,
         default: 20,
         description: 'Maximum items to return'
       }
     }
     ```
2. **Zod Validation Schema (`z.object(...)`)**:
   - Re-exported directly from `mcponce` (`import { z } from 'mcponce'`).
   - Supports validation constraints (`min`, `max`, `regex`, `transform`, `default`).
   - Use `.describe('...')` to provide descriptions to AI models.
3. **Raw JSON Schema Object**:
   - Supports standard JSON Schema: `{ type: 'object', properties: { ... }, required: [...] }`.

---

## 4. Handler Context & Advanced Capabilities

Tool handlers receive three arguments:
```ts
async handler(args: TArgs, context: TContext, extra: ToolExtra)
```

### 1. Shared Application Context (`context`)
Use `app.context(factory)` to initialize shared database pools, API clients, or configurations once:

```ts
interface AppContext {
  db: DatabaseConnection;
  apiKey: string;
}

const app = createMcpServer<AppContext>({ name: 'db-server' });

app.context(async () => {
  const db = await connectDatabase(process.env.DATABASE_URL!);
  return { db, apiKey: process.env.SERVICE_API_KEY! };
});

app.tool({
  name: 'query_orders',
  inputSchema: { status: 'string' },
  async handler({ status }, { db }) {
    const orders = await db.query('SELECT * FROM orders WHERE status = $1', [status]);
    return orders;
  }
});
```

### 2. Inter-Tool Invocations (`context.callTool`)
Tools can directly call other registered tools with complete telemetry, middleware, validation, and call-graph tracking:

```ts
app.tool({
  name: 'generate_invoice',
  inputSchema: { orderId: 'string' },
  async handler({ orderId }, { callTool }) {
    // 1. Call another tool internally
    const orderResult = await callTool('get_order', { orderId });
    const order = orderResult.data;

    // 2. Call calculation tool
    const taxResult = await callTool('calculate_tax', { amount: order.subtotal });

    return {
      orderId,
      subtotal: order.subtotal,
      tax: taxResult.data.tax,
      total: order.subtotal + taxResult.data.tax
    };
  }
});
```

### 3. Real-Time Progress Reporting (`context.reportProgress`)
For long-running tasks, send real-time percentage and status updates to LLM clients and CLI spinners:

```ts
app.tool({
  name: 'sync_records',
  inputSchema: { count: 'number' },
  async handler({ count }, { reportProgress }) {
    for (let i = 1; i <= count; i++) {
      await processItem(i);
      // Sends MCP $/progress notification to client and updates CLI progress bar
      reportProgress(i, count, `Processed item ${i} of ${count}`);
    }
    return { success: true, count };
  }
});
```

### 4. Client Workspace Roots (`context.listRoots`)
Inspect folders opened in the client's workspace (e.g. Cursor or Claude Desktop):

```ts
app.tool({
  name: 'list_project_files',
  inputSchema: {},
  async handler(_args, { listRoots }) {
    const roots = await listRoots();
    return { workspaceRoots: roots };
  }
});
```

### 5. Dynamic LLM Sampling (`context.sample`)
Request the connected LLM client (e.g. Claude) to generate text or structured completions dynamically:

```ts
app.tool({
  name: 'summarize_document',
  inputSchema: { text: 'string' },
  async handler({ text }, { sample }) {
    const response = await sample({
      messages: [{ role: 'user', content: `Summarize this text in 2 sentences:\n\n${text}` }],
      maxTokens: 150
    });
    return response.content.text;
  }
});
```

### 6. Timeouts & Cancellation (`context.signal`)
Always pass `signal` to async operations (HTTP requests, database queries, child processes). When an LLM user cancels a request or a timeout fires, operations abort immediately without leaking resources:

```ts
app.tool({
  name: 'download_report',
  inputSchema: { url: 'string' },
  timeoutMs: 15000,
  async handler({ url }, { signal }) {
    const res = await fetch(url, { signal });
    return await res.text();
  }
});
```

---

## 5. Returning Content (Media, Images & Resources)

`mcponce` automatically converts return values into valid MCP `CallToolResult` structures:

| Handler Return Value | Resulting MCP Content |
| :--- | :--- |
| `string` | Single `{ type: 'text', text: '...' }` |
| `object` or `array` | Single `{ type: 'text', text: JSON.stringify(...) }` and typed `result.data` |
| `Buffer` or `Uint8Array` | Auto-detects MIME type (PNG, JPEG, WebP, GIF) and encodes as `{ type: 'image', data: base64, mimeType }` |
| `image(buffer, 'image/png')` | Image content helper |
| `resource(uri, text, mimeType)` | Embedded resource content |
| `{ content: [...], isError: true }` | Custom error result without throwing exceptions |

```ts
import { createMcpServer, image } from 'mcponce';
import fs from 'node:fs';

app.tool('get_chart', {}, async () => {
  const pngBuffer = fs.readFileSync('./chart.png');
  return image(pngBuffer, 'image/png');
});
```

---

## 6. Resources & Resource Templates

Resources expose read-only contextual data, files, logs, or system states to LLMs.

### Static Resources (`app.resource(...)`)
```ts
app.resource({
  uri: 'system://info',
  name: 'System Information',
  description: 'Real-time host and runtime environment info',
  mimeType: 'application/json',
  async handler(uri) {
    return JSON.stringify({
      nodeVersion: process.version,
      platform: process.platform,
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
  }
});
```

### Dynamic Resource Templates (`app.resourceTemplate(...)`)
Dynamic URIs with path parameters (e.g. `users://{id}`):

```ts
app.resourceTemplate({
  uriTemplate: 'users://{id}',
  name: 'User Record',
  description: 'Retrieve user details by ID',
  mimeType: 'application/json',
  async handler(uri, { id }) {
    const user = await fetchUserById(id);
    return JSON.stringify(user);
  },
  // Optional autocomplete handler for URI parameters
  complete: {
    id: async (value) => {
      const candidates = ['user-101', 'user-102', 'admin-001'];
      return candidates.filter(c => c.startsWith(value));
    }
  }
});
```

---

## 7. Prompts & Protocol Autocompletion

Prompts are reusable prompt engineering templates exposed to clients.

```ts
app.prompt({
  name: 'code_review',
  description: 'Generate a structured code review prompt for a specific language',
  argsSchema: {
    language: 'string',
    code: 'string'
  },
  complete: {
    language: async (val) => ['typescript', 'python', 'go', 'rust', 'csharp'].filter(l => l.startsWith(val))
  },
  async handler({ language, code }) {
    return {
      messages: [
        {
          role: 'user',
          content: `Please review the following ${language} code for security, performance, and style:\n\n\`\`\`${language}\n${code}\n\`\`\``
        }
      ]
    };
  }
});
```

---

## 8. Enterprise Resilience & Production Controls

### 1. In-Memory Tool Caching (`cache`)
Eliminate duplicate database queries or API hits:

```ts
app.tool({
  name: 'get_weather',
  inputSchema: { city: 'string' },
  cache: {
    ttlMs: 60_000, // 60 seconds
    key: (args) => args.city.toLowerCase() // Custom cache key generator
  },
  async handler({ city }) {
    return await fetchWeatherApi(city);
  }
});
```

### 2. Automatic Retries with Exponential Backoff (`retry`)
```ts
app.tool({
  name: 'unreliable_remote_api',
  inputSchema: { id: 'string' },
  retry: {
    maxRetries: 3,
    initialDelayMs: 200,
    maxDelayMs: 2000,
    backoffFactor: 2,
    retryableErrors: (err) => err.message.includes('503') || err.message.includes('ECONNRESET')
  },
  async handler({ id }) {
    return await callExternalService(id);
  }
});
```

### 3. Concurrency & Sequential Queues (`queue` / `sequential`)
Prevent database lockups and race conditions:

```ts
// Enforce single-threaded FIFO execution for critical database writes
app.tool({
  name: 'create_invoice',
  inputSchema: { amount: 'number' },
  sequential: true, // Alias for queue: { key: 'tool:create_invoice', maxConcurrency: 1 }
  async handler({ amount }) {
    return await db.insertInvoice(amount);
  }
});

// Enforce custom concurrency limit across multiple related tools
app.tool({
  name: 'bulk_scrape',
  inputSchema: { url: 'string' },
  queue: { key: 'web-scraper', maxConcurrency: 3 }, // Maximum 3 concurrent requests across the entire server
  async handler({ url }) {
    return await scrape(url);
  }
});
```

### 4. Middleware Pipelines (`app.use`)
Intercept and wrap every tool invocation:

```ts
// Global logging and audit middleware
app.use(async (ctx, next) => {
  const start = Date.now();
  try {
    const result = await next();
    const duration = Date.now() - start;
    console.error(`[AUDIT] Tool "${ctx.tool}" succeeded in ${duration}ms`);
    return result;
  } catch (err: any) {
    console.error(`[AUDIT] Tool "${ctx.tool}" failed: ${err.message}`);
    throw err;
  }
});

// Selective middleware by tool name or filter
app.use({
  filter: ['admin_delete_user', 'admin_drop_table'],
  handler: async (ctx, next) => {
    if (!ctx.context.isAdmin) {
      throw new Error('Unauthorized: Admin access required');
    }
    return next();
  }
});
```

### 5. Authentication & Security (`app.auth`)
Protect HTTP `/mcp` endpoints with API keys or Bearer tokens:

```ts
const app = createMcpServer({
  name: 'secure-server',
  auth: {
    apiKey: process.env.MCP_API_KEY,      // Static token check
    // Or dynamic validator:
    // validator: async (token) => token === 'secret' ? { user: 'admin', scopes: ['read', 'write'] } : null
  }
});
```

---

## 9. Testing Guidelines for Agents

### Unit Testing Tools in Vitest / Node Test
Tools can be tested in-memory without starting an HTTP daemon:

```ts
import { describe, it, expect } from 'vitest';
import { createMcpServer } from 'mcponce';

describe('Server Tools', () => {
  it('executes calculate tool with correct output', async () => {
    const app = createMcpServer('test-server');
    app.tool('add', { a: 'number', b: 'number' }, async ({ a, b }) => a + b);

    // Call tool programmatically
    const result = await app.callTool('add', { a: 15, b: 25 });
    
    expect(result.data).toBe(40);
    expect(result.isError).toBeFalsy();
  });
});
```

### Integration Testing over MCP Protocol
```ts
it('serves tools over HTTP POST /mcp', async () => {
  const app = createMcpServer({ name: 'http-test', port: 0, registerInCentral: false });
  app.tool('hello', { name: 'string' }, async ({ name }) => `Hello ${name}!`);

  const { host, port } = await app.start();
  try {
    const res = await fetch(`http://${host}:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hello', arguments: { name: 'World' } }
      })
    });
    const body = await res.json();
    expect(body.result.content[0].text).toBe('Hello World!');
  } finally {
    await app.stop();
  }
});
```

---

## 10. Built-in CLI & Developer Workflow

Every server created with `await app.run()` includes a complete CLI without any extra code:

### 1. Execute Tools Directly from Terminal
```bash
# Direct call with flag arguments
node server.js call greet --name "Alice"

# Numeric and boolean arguments
node server.js call calculate_discount --price 120 --discountPercent 25

# Machine-readable JSON output
node server.js call greet --name "Alice" --json
```

### 2. Discover Tools & Schemas
```bash
node server.js tools
```

### 3. Open Interactive Web Inspector
```bash
# Launches browser at http://127.0.0.1:port/inspect
node server.js inspect
```

### 4. Telemetry & Analytics
```bash
# View invocation counts, error rates, latencies, and call graph
node server.js analytics
node server.js analytics --json
```

### 5. Auto-Install into AI Clients
```bash
# Automatically updates Claude Desktop and Cursor config files
node server.js install
node server.js install cursor
node server.js install claude
```

---

## 11. Central Registry & Central CLI (`mcponce`)

When servers start, they register in `~/.mcponce/servers.json` (unless `registerInCentral: false`). You can control all local MCP servers globally:

```bash
# List all running/stopped MCP servers on the machine
npx mcponce list

# Show runtime status and metrics
npx mcponce status my-server

# Call any registered server
npx mcponce call my-server greet --name "Bob"

# Inspect server analytics
npx mcponce analytics my-server

# Open Web Inspector for running server
npx mcponce inspect my-server

# Stop server daemon
npx mcponce stop my-server
```

---

## 12. Golden Rules & Agent Checklist (Strict Do's and Don'ts)

| Rule | What to Do | What NEVER to Do |
| :--- | :--- | :--- |
| **STDOUT Cleanliness** | Write diagnostic logs to `stderr` or use `logger.info()` / `console.error()`. | **NEVER** use `console.log()` in code paths that run during MCP sessions. It breaks the JSON-RPC protocol! |
| **Descriptions for LLMs** | Provide descriptive `description` for tools and parameters (`.describe('...')`). | Don't leave tool descriptions blank or cryptic (`desc: 'run'`). The LLM relies on them to choose the tool. |
| **Lifecycle** | Always end the entrypoint script with `await app.run();`. | Don't call `app.start()` inside an entrypoint intended for CLI and client execution. |
| **Input Validation** | Use Zod schemas or concise shorthand with explicit optional markers (`?`). | Don't manually parse string inputs inside the handler; let `mcponce` coerce and validate. |
| **Resource Safety** | Always pass `context.signal` to `fetch()`, database queries, and child processes. | Don't ignore `signal`. Leaked long-running calls cause port leaks and zombie processes. |
| **Error Handling** | Throw standard `new Error('descriptive message')`. `mcponce` formats it safely into `{ isError: true }`. | Don't swallow errors with empty `try/catch` blocks. |
| **Imports** | Import from `'mcponce'` or relative paths in the package. | Don't re-implement transports or JSON-RPC serialization manually. |

---

*This guide was generated for AI Agents and Developers writing MCP servers with `mcponce`.*
