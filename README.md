# mcponce

> **Cross-platform MCP server from a single executable file** powered by **Hono** and the official **Model Context Protocol SDK**.

> [!NOTE]
> **Project Status: Alpha (`v0.2.x`)**
> `mcponce` is currently in active **Alpha** development. Core features (dual-transport stdio/HTTP bridging, background daemon sharing, caching, concurrency controls, and CLI tools) are functional and tested, but APIs and internal interfaces are subject to refinement before a `v1.0.0` stable release. We welcome community testing and feedback.

Add the MCP server once in your client settings, point it to one executable file, and let that file automatically start or reuse the local server.

```text
Claude / Cursor / Antigravity / VS Code
                  │
                  │ stdio
                  ▼
          Single executable file
                  │
                  ├── starts server if needed
                  ├── discovers existing server
                  ├── proxies MCP messages
                  └── writes logs/runtime state
                  │
                  ▼
          Local Hono + MCP server
                  │
                  └── shared tools/resources/context
```

## Features

- **Single Executable UX**: No manual daemons to start, stop, or manage. One executable handles both server ownership and stdio bridging.
- **Cross-Platform**: Works out of the box on macOS, Linux, and Windows using native OS application state paths.
- **Dynamic Port Allocation**: Defaults to `port: 0` so the operating system assigns an available port. No port conflicts.
- **Robust Single-Instance**: Atomic lock files with `O_CREAT | O_EXCL`, HTTP `/health` verification, race handling with retry backoff, and automatic stale lock/crash recovery.
- **Shared Application Context**: Initialize database, caches, or connections once for the server, shared across all simultaneous client sessions.
- **Smart Input Coercion & Schema Defaults**: Shields handlers from LLM stringification errors (`"42"` -> `42`, `"false"` -> `false`, JSON strings to objects) with `coerceInputs: true` and schema defaults.
- **Automatic Retries with Exponential Backoff**: Declarative `retry: 3` with configurable exponential delays, cancellation aborts, selective predicates, and telemetry tracking.
- **In-Memory Response Caching**: LRU response caching (`cache: true` or custom TTL) with deterministic argument sorting and fine-grained invalidation.
- **Sequential Queuing & Mutexes**: Prevent race conditions with `sequential: true` or named mutex locks.
- **Images & Binary Media**: Return raw `Buffer`s or use `image(buffer)` helpers with automatic magic byte MIME detection (PNG, JPEG, GIF, WEBP, BMP, SVG) and base64 encoding.
- **Dynamic Resource URI Templates (RFC 6570)**: Expose parametric resources (`users://{userId}/profile`) with parameter extraction, client autocompletion callbacks, and automatic return normalization.
- **Resource Subscriptions & Live Push**: Client subscriptions (`resources/subscribe`, `resources/unsubscribe`) with live push updates (`app.notifyResourceUpdated`, `app.notifyResourceListChanged`).
- **Security, Authentication & Rate Limiting**: Multi-key Bearer/API Key auth, custom identity validators (`auth.validate`), tool-level RBAC scopes, sliding-window rate limiting (429 Retry-After), and standard security headers.
- **MCP Sampling & Workspace Roots**: Enable autonomous sub-agents by requesting LLM completions back from the client (`context.sample`) and querying open IDE workspace directories (`context.listRoots`).
- **OpenAPI / Swagger Auto-Generation**: Transform any REST API into type-safe MCP tools in 1 line with `app.fromOpenApi()`.
- **Interactive Web Inspector & Playground**: Zero-dependency browser developer UI at `/inspect` (`mcponce inspect` / `server.js inspect`) with dynamic form generation, execution diagnostics, and live metrics.
- **MCP Autocomplete Protocol**: Full `completion/complete` support for prompt arguments, resource template variables, and tool parameters.
- **Client Auto-Installer**: Automatically configure servers into Claude Desktop or Cursor in 1 command: `node server.js install` or `mcponce install <target>`.
- **Clean Protocol Communication**: `stdout` is reserved strictly for MCP JSON-RPC protocol messages. Diagnostic and error logs are written safely to log files and `stderr`.
- **Hono & Official MCP SDK**: Native Web Standards Streamable HTTP transport integration.

## Comparison & Alternatives

Different tools in the MCP ecosystem serve distinct architectural needs and maturity levels:

| Dimension / Capability | Official SDK (`@modelcontextprotocol/sdk`) | FastMCP (TypeScript / Python) | Standalone Proxies (e.g., Supergateway) | **mcponce** |
| :--- | :---: | :---: | :---: | :---: |
| **Maturity / Stage** | **Official Reference (Stable)** | **Community Standard (Mature)** | **Production Utility (Stable)** | **Alpha (`v0.2.x`, Active Dev)** |
| **Primary Focus** | Specification reference & wire protocol primitives | Ergonomic syntax for quick scripts & tools | Wrapping existing stdio servers without code changes | All-in-one developer framework & daemon bridge |
| **HTTP Transport** | Core transport primitives (SSE/HTTP) | Built-in HTTP/SSE server | Built-in HTTP proxy | Native [Hono](https://hono.dev/) Streamable HTTP & stdio |
| **Multi-Client Daemon** | Userland (1 process per stdio connection) | Userland (1 process per connection) | Per-process or gateway pool | Single shared background daemon via Unitup |
| **Concurrency & Mutex** | Userland implementation | Standard async | Proxy-level buffering | Built-in FIFO queues & named mutexes (`sequential: true`) |
| **Input Coercion** | JSON Schema (strict validation) | First-class Zod validation | Raw pass-through | Zod + Smart coercion (`"42"` ➔ `42`, JSON strings to objects) |
| **Response Caching** | Userland implementation | Userland implementation | Not applicable | Built-in LRU cache with TTL & invalidation |
| **Inter-Tool Calling** | Manual invocation | Manual invocation | Not applicable | Built-in `context.callTool` with recursion guard |
| **Automatic Retries** | Userland implementation | Userland implementation | Not applicable | Declarative backoff & jitter (`retry: 3`) |
| **Observability & Metrics** | Custom logger integration | Standard logging & events | Request logs | Built-in Prometheus (`/metrics`) & JSON Telemetry (`/analytics`) |
| **CLI & Testing** | Via MCP clients / inspector package | Built-in CLI & dev mode | HTTP / curl | Built-in `mcponce call` with progress reporting |
| **Client Auto-Installer** | Manual JSON config | Built-in CLI install / manual | Manual JSON config | Built-in `mcponce install` (Claude Desktop & Cursor) |
| **Developer UI** | Separate `@modelcontextprotocol/inspector` | Built-in `fastmcp dev` UI | Not applicable | Built-in `/inspect` playground (`mcponce inspect`) |
| **OpenAPI Auto-Gen** | Userland scripts | Community plugins / custom | Not applicable | Built-in `app.fromOpenApi()` & CLI `mcponce openapi` |

### When to choose what?

- **Choose the Official SDK** if you want the canonical, stable reference implementation from Anthropic, require minimal third-party dependencies, or are embedding MCP into existing frameworks (NestJS, Express, Fastify) that already manage their own lifecycle, caching, and queueing.
- **Choose FastMCP** if you want an established, mature community standard with a clean, concise syntax for quickly exposing scripts and tools to AI clients without needing daemon multiplexing or Prometheus metrics.
- **Choose Standalone Proxies (Supergateway / mcp-proxy)** if you have an existing third-party stdio MCP server binary and want to expose it over HTTP/SSE without modifying any code.
- **Choose `mcponce`** if you want an all-in-one developer experience with shared background daemon efficiency (avoiding duplicate processes for multiple IDE/Claude windows), built-in resilience primitives (mutex queues, input coercion, retries, cache), and turnkey CLI/Inspector tooling — keeping in mind that **mcponce is currently in Alpha (`v0.2.x`)** and actively stabilizing.

## Installation

```bash
npm install mcponce
```

## Quick Start

```ts
import { createMcpServer } from "mcponce";

// 1-parameter shorthand or config object:
const app = createMcpServer("my-mcp");

app.tool({
  name: "hello",
  description: "Say hello",
  inputSchema: {
    name: "string"
  },
  async handler({ name }) {
    return {
      content: [{ type: "text", text: `Hello ${name}!` }]
    };
  }
});

app.run();
```

### Calling Tools Within One Another (Inter-Tool Invocations)

Tools can invoke other registered tools internally with full argument validation, automatic cycle detection, and unwrapped data access:

```ts
app.tool({
  name: "add",
  inputSchema: { a: "number", b: "number" },
  handler: ({ a, b }) => a + b
});

app.tool({
  name: "add_and_double",
  inputSchema: { a: "number", b: "number" },
  // 1. Access callTool directly from the context parameter:
  async handler({ a, b }, { callTool }) {
    const sumResult = await callTool("add", { a, b });
    return sumResult.data * 2;
  }
});
```

You can also invoke tools programmatically directly on the server instance (great for testing):

```ts
const result = await app.callTool("add", { a: 10, b: 20 });
console.log(result.data); // 30
console.log(result.text); // "30"
```

### Images & Binary Media Support (Screenshots, Charts & Buffers)

Many tools produce visual output (e.g. Playwright browser screenshots, canvas charts, PDF previews). In `mcponce`, returning a raw `Buffer` or using `image(buffer)` automatically normalizes into the standard MCP `ImageContent` block with magic-byte MIME type detection (PNG, JPEG, GIF, WEBP, BMP, SVG):

```ts
import { image } from "mcponce";
import fs from "node:fs/promises";

// 1. Direct Buffer return (MIME type is auto-detected from magic bytes!)
app.tool({
  name: "capture_screen",
  handler: async () => {
    return await fs.readFile("./screenshot.png");
  }
});

// 2. Mixed multi-part content (Text + Image)
app.tool({
  name: "render_dashboard",
  handler: async () => {
    const chartBuffer = await generateChart();
    return [
      "Here is the Q3 performance report:",
      image(chartBuffer),
      "Summary: Growth exceeded forecasts by 18%."
    ];
  }
});
```

### Dynamic Resource URI Templates (RFC 6570)

Expose parametric, dynamic resources to AI clients and developers. `mcponce` supports RFC 6570 URI templates with automated variable extraction, client autocompletions, and return normalization:

```ts
app.resourceTemplate({
  uriTemplate: "users://{userId}/profile",
  name: "user_profile",
  description: "User profile details",
  mimeType: "application/json",
  complete: {
    // Autocompletions surfaced in Claude Desktop & Cursor
    userId: async (prefix) => ["alice", "bob", "charlie"].filter((u) => u.startsWith(prefix))
  },
  handler: async (uri, { userId }) => {
    // Return objects, strings, or Buffers—mcponce normalizes them automatically!
    return {
      userId,
      role: "developer",
      url: uri.href
    };
  }
});

// Programmatic reading (great for tests and inter-service reads)
const profile = await app.readResource("users://alice/profile");
```

### Resource Subscriptions & Live Push Notifications

Clients like Claude Desktop or Cursor can subscribe to dynamic resources via `resources/subscribe`. When application state changes, notify all subscribed clients in real time using `app.notifyResourceUpdated(uri)` or notify that the resource list changed using `app.notifyResourceListChanged()`.

```ts
app.resource({
  uri: "status://system",
  name: "system_status",
  mimeType: "application/json",
  handler: async () => ({ status: getSystemStatus(), timestamp: Date.now() })
});

// Broadcast live push notification to all subscribed clients:
app.notifyResourceUpdated("status://system");

// Broadcast when new resources are added or removed:
app.notifyResourceListChanged();

// Hook into subscription events:
app.onResourceUpdated((uri, sessionIds) => {
  console.log(`Resource ${uri} was updated for ${sessionIds.length} subscribers`);
});
```

### Security, Authentication & Rate Limiting

Secure your MCP HTTP/SSE endpoints with multi-key authentication, custom identity validators (`auth.validate`), tool-level RBAC scopes, sliding-window rate limiting, and standard security headers. The public `/health` endpoint remains open for container orchestration and uptime monitoring.

```ts
const app = createMcpServer({
  name: "secure-mcp-server",
  // 1. Static API keys (Bearer token or X-API-Key header)
  apiKey: ["secret-token-12345", "backup-key-67890"],

  // 2. Or custom identity validator with RBAC scopes
  auth: {
    validate: async (token, context) => {
      const user = await verifyJwt(token);
      return user ? { id: user.id, user: user.email, scopes: user.scopes } : false;
    }
  },

  // 3. Sliding-window rate limiting (returns 429 & Retry-After)
  rateLimit: {
    max: 100,
    windowMs: 60 * 1000
  },

  // 4. Configurable CORS & security headers
  cors: {
    origin: "https://app.example.com",
    credentials: true
  }
});

// 5. Tool-level permission scopes
app.tool({
  name: "admin_delete_user",
  inputSchema: { userId: "string" },
  requireAuth: true,
  scopes: ["admin:users", "write"],
  handler: async ({ userId }, ctx, extra) => {
    console.log(`Executed by: ${extra.auth?.user}`);
    return `User ${userId} deleted`;
  }
});
```

Clients authenticate using standard headers or CLI flags:
- **Authorization Header**: `Authorization: Bearer secret-token-12345`
- **Custom Header**: `X-API-Key: secret-token-12345`
- **CLI Caller**: `mcponce call my-server admin_delete_user --userId 42 --token secret-token-12345`

### MCP Sampling & Workspace Roots (Sub-Agents)

Turn your tools into autonomous sub-agents by requesting LLM completions (`sampling/createMessage`) back from the connected client (Claude Desktop, Cursor, AI agents). Tools can also discover open project folders via the MCP Roots protocol (`roots/list`).

```ts
app.tool({
  name: "code_reviewer",
  inputSchema: { patch: "string" },
  async handler({ patch }, { sample, listRoots }) {
    // 1. Discover user's project directories in their IDE
    const roots = await listRoots();

    // 2. Request an LLM completion from the connected client
    const reply = await sample({
      prompt: `Review this diff and suggest performance improvements:\n\n${patch}`,
      systemPrompt: "You are a senior code reviewer. Output a concise markdown report.",
      maxTokens: 500,
      temperature: 0.2
    });

    return {
      review: reply.text,
      modelUsed: reply.model,
      workspace: roots[0]?.name
    };
  }
});

// Configure offline mock fallback during testing or standalone runs:
app.onSample(async (params) => {
  return "Mock review for test environment";
});
```

### OpenAPI & Swagger Tool Auto-Generation (`app.fromOpenApi`)

Transform entire REST APIs into type-safe MCP tools in a single line. Supports OpenAPI v3.0, v3.1, and Swagger 2.0 specs via remote URLs, local file paths, JSON/YAML strings, or JS objects:

```ts
// 1. From remote URL or local file path
await app.fromOpenApi("https://petstore.swagger.io/v2/swagger.json", {
  prefix: "petstore", // e.g. "petstore_get_pet_by_id"
  headers: {
    Authorization: `Bearer ${process.env.API_KEY}`
  }
});

// 2. Or from an inline specification with tag filtering
await app.fromOpenApi(specObject, {
  baseUrl: "https://api.example.com",
  tags: ["users", "billing"], // only generate tools for these tags
  exclude: ["internal_*"],
  transformResponse: (res) => res.data // extract inner payload
});
```

All query, path, and header parameters as well as JSON request bodies are automatically mapped to pre-compiled Zod schemas with complete parameter type coercion.

### Workspace Roots Security & Path Traversal Guards

When LLM agents operate across user files, `mcponce` provides path traversal defense helpers to ensure all file operations stay safely confined inside open IDE workspace roots:

```ts
import { isPathInWorkspace, resolveWorkspacePath } from "mcponce";

app.tool({
  name: "read_workspace_file",
  inputSchema: { relativePath: "string" },
  async handler({ relativePath }, { listRoots }) {
    const roots = await listRoots();

    // Resolves path and throws an error if "../" attempts to escape roots
    const safePath = resolveWorkspacePath(relativePath, roots);
    return await fs.readFile(safePath, "utf-8");
  }
});
```

### Interactive Web Inspector & Playground (`/inspect`)

Every `mcponce` server includes a zero-dependency, dark-mode developer playground accessible directly at `http://localhost:<port>/inspect`.

Launch it directly during development:

```bash
# Start your server and auto-open the Web Inspector
node server.js inspect

# Or open inspector for an active background server
mcponce inspect my-server
```

- **Dynamic Form Generation**: Form controls automatically generated from tool `inputSchema` with type validation and sample value population.
- **Live Output Console**: Syntax-highlighted JSON trees, execution duration timers in milliseconds, and LRU cache HIT/MISS indicators.
- **Binary Media Renderer**: Renders image outputs directly in the browser.
- **Live Telemetry**: Real-time request counts, error counts, active sessions, and direct links to `/metrics` (Prometheus) and `/analytics` (JSON).

### MCP Autocomplete Protocol (`completion/complete`)

Enable instant autocompletion in AI clients (Cursor, Claude Desktop, Antigravity) as users or agents type arguments:

```ts
// 1. Prompt Argument Autocompletion
app.prompt({
  name: "conventional_commit",
  argsSchema: { type: "string" },
  complete: {
    type: (query) => ["feat", "fix", "docs", "style", "refactor", "test"].filter((t) => t.startsWith(query))
  },
  handler: ({ type }) => ({ messages: [...] })
});

// 2. Resource Template Autocompletion
app.resourceTemplate({
  uriTemplate: "repos://{owner}/{repo}",
  complete: {
    owner: (query) => ["litepacks", "facebook", "microsoft"].filter((o) => o.startsWith(query)),
    repo: (query, context) => context?.arguments?.owner === "litepacks" ? ["mcponce", "unitup"] : []
  },
  handler: async (uri, params) => ...
});
```



### Strict Naming Validation (AI Provider & Cross-Platform Compatibility)

Many AI providers (OpenAI, Anthropic Claude, Google Gemini) and MCP clients (Cursor, Claude Desktop, Antigravity) enforce strict naming requirements on tools and functions. For instance, OpenAI strictly rejects tool names with spaces, dots, or symbols (`^[a-zA-Z0-9_-]{1,64}$`), causing runtime API errors if violated.

`mcponce` automatically validates names upon registration and provides clear, actionable error messages with suggested alternatives:

- **Tool Names (`tool.name`)**: Must be 1–64 characters matching `/^[a-zA-Z0-9_-]{1,64}$/`. No spaces, dots, slashes, or unicode symbols.
- **Parameter Names (`inputSchema` keys)**: Must be 1–64 characters matching `/^[a-zA-Z0-9_-]{1,64}$/` to ensure schema compatibility with all LLM tool calling providers.
- **Server Names (`config.name`)**: Must be 1–128 characters matching `/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/`. Disallows path traversal (`..`, `/`, `\`), Windows reserved names (`CON`, `PRN`, `NUL`, etc.), and whitespace, guaranteeing cross-platform filesystem and daemon compatibility.
- **Prompt Names (`prompt.name`)**: Must match `/^[a-zA-Z0-9_-]{1,64}$/`.

```ts
import { isValidToolName, sanitizeToolName, sanitizeServerName } from "mcponce";

console.log(isValidToolName("get_user")); // true
console.log(isValidToolName("get user")); // false (spaces rejected by LLM providers)
console.log(sanitizeToolName("my tool: calculate!")); // "my_tool_calculate"
```

### Timeouts, Cancellation, and Error Resilience

`mcponce` provides built-in timeout, cancellation, and error handling out of the box:

- **Per-Tool & Global Timeouts**: Set `timeoutMs` per tool or `toolTimeoutMs` globally on the server (defaults to 60s, configurable via `MCP_TOOL_TIMEOUT_MS`). Set `timeoutMs: 0` to disable timeouts for long-running batch jobs.
- **Client Cancellation (`notifications/cancelled`)**: When a user clicks "Stop" in Claude, Cursor, or Antigravity, the client sends `notifications/cancelled`. `mcponce` automatically aborts the tool's `signal` (`AbortSignal`).
- **Resilient Handler Racing**: Even if a tool handler ignores the signal and hangs in a promise, `mcponce` races execution against the timeout/cancellation signal and aborts promptly without hanging the server.
- **MCP Spec Compliant Errors**: Tool exceptions and timeouts never crash the server or tear down HTTP/SSE sessions. They return structured `{ isError: true, content: [...] }` so LLMs can observe the failure and self-correct.

```ts
app.tool({
  name: "fetch_webpage",
  description: "Fetches webpage content with cancellation & timeout",
  inputSchema: { url: "string" },
  timeoutMs: 5000, // Tool-specific 5-second timeout
  async handler({ url }, { signal }) {
    // Pass signal to fetch() or your async operations.
    // If the client cancels or timeout expires, fetch aborts immediately!
    const res = await fetch(url, { signal });
    return await res.text();
  }
});

// Programmatic tool calls with custom timeout or AbortController:
const controller = new AbortController();
const res = await app.callTool("fetch_webpage", { url: "https://example.com" }, {
  signal: controller.signal,
  timeoutMs: 3000,
  throwOnError: false // returns { isError: true, ... } instead of throwing
});
```

### Sequential Execution & Concurrency Control (Queuing & Mutexes)

When tools interact with stateful or rate-limited resources (e.g. browser automation via Playwright/Puppeteer, hardware devices, database transactions, or single-session APIs), concurrent invocations can cause race conditions or state corruption.

`mcponce` provides built-in concurrency control and deterministic FIFO queuing:

- **Server-Level Sequential (`sequential: true`)**: All tool calls across the entire server are queued and executed one-by-one in strict FIFO order. Can also be enabled via environment variable `MCP_SEQUENTIAL=true`.
- **Server-Level Max Concurrency (`maxConcurrency: N`)**: Limits the number of simultaneous tool executions across the entire server to `N` (configurable via `MCP_MAX_CONCURRENCY`).
- **Tool-Level Sequential (`sequential: true`)**: Invocations of this specific tool run one at a time. Other independent tools continue running concurrently.
- **Tool-Level Max Concurrency (`maxConcurrency: N`)**: Limits simultaneous invocations of this specific tool to `N`.
- **Named Mutex Groups (`sequential: "group_name"`)**: Multiple distinct tools can share a single mutex queue. For example, `browser_click`, `browser_type`, and `browser_navigate` can all specify `sequential: "browser"` so they never run concurrently with each other while allowing other tools (like calculations or file reads) to run freely.
- **Safe Re-Entrancy**: Inter-tool calls (tools calling other tools via `context.callTool`) automatically detect that the parent caller already holds the queue lock, preventing deadlocks.
- **Queue Introspection**: Call `app.getQueueStats()` to inspect active tasks and waiting queue lengths at runtime.

#### Server-Level Sequential Mode

```ts
const app = createMcpServer({
  name: "single-threaded-app",
  sequential: true // All tools execute serially one at a time
  // or: maxConcurrency: 2
});
```

#### Tool-Level Sequential & Named Mutexes

```ts
// 1. Tool-level serial execution
app.tool({
  name: "write_ledger",
  description: "Appends to an accounting ledger without race conditions",
  sequential: true, // Only one ledger write at a time
  async handler({ entry }) {
    await appendToLedger(entry);
  }
});

// 2. Shared named mutex across multiple browser tools
app.tool({
  name: "browser_navigate",
  sequential: "browser_session", // Shares queue with browser_click
  async handler({ url }) {
    await page.goto(url);
  }
});

app.tool({
  name: "browser_click",
  sequential: "browser_session", // Shares queue with browser_navigate
  async handler({ selector }) {
    await page.click(selector);
  }
});

// 3. Rate-limited tool with maxConcurrency
app.tool({
  name: "scrape_page",
  maxConcurrency: 3, // At most 3 simultaneous scrape jobs
  async handler({ url }) {
    return await scrape(url);
  }
});
```

### In-Memory Tool Response Caching

LLM workflows frequently re-query read-only tools with identical arguments across turns (e.g. `get_weather`, `search_docs`, `fetch_schema`, `get_stock_quote`), incurring redundant latency, API costs, and database load.

`mcponce` provides built-in, zero-dependency in-memory response caching with automatic LRU eviction and deterministic argument hashing:

- **Quick Caching (`cache: true`)**: Caches tool responses with a default 60-second TTL and 100-entry LRU limit.
- **Custom TTL & Limits (`cache: { ttlMs: 30_000, maxSize: 250 }`)**: Set custom expiration and capacity per tool.
- **Deterministic Argument Hashing**: `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hit the exact same cache entry via key-sorted recursive serialization.
- **Cache Invalidation**:
  - Inside mutating tools: `context.clearCache("other_tool")`.
  - Programmatically: `app.clearCache("tool_name")` (or `app.clearCache()` to evict all).
- **Cache Bypass**: Call with `{ noCache: true }` in code or `--no-cache` via CLI.
- **Protocol Transparency**: Seamlessly caches both programmatic calls and remote MCP client calls over HTTP / SSE.
- **Error Non-Caching**: Only successful responses are cached. Errors and timeouts are never cached.

```ts
// 1. Tool with 30-second response caching
app.tool({
  name: "fetch_stock_quote",
  description: "Fetches latest stock price with 30s cache",
  inputSchema: { symbol: "string" },
  cache: { ttlMs: 30_000 },
  async handler({ symbol }) {
    return await api.getQuote(symbol);
  }
});

// 2. Invalidate cache from a mutating tool
app.tool({
  name: "update_stock_symbol",
  inputSchema: { symbol: "string", price: "number" },
  async handler({ symbol, price }, { clearCache }) {
    await db.updatePrice(symbol, price);
    clearCache("fetch_stock_quote"); // Evicts cached quotes
  }
});

// 3. Programmatic cache bypass and cache stats
await app.callTool("fetch_stock_quote", { symbol: "AAPL" }, { noCache: true });
console.log(app.getCacheStats()); // { size: 1, hits: 14, misses: 2, evictions: 0 }
```

### Automatic Tool Retries with Exponential Backoff

Tools frequently encounter transient network hiccups, brief database reconnects, or upstream API rate limits (e.g. 503 Service Unavailable, 429 Too Many Requests). Without automated recovery, transient errors fail the entire LLM workflow.

`mcponce` provides built-in, zero-dependency declarative retries with exponential backoff:

- **Shorthand (`retry: 3`)**: Automatically retries up to 3 times with exponential backoff (100ms, 200ms, 400ms).
- **Detailed Configuration (`retry: { attempts, backoffMs, factor, maxBackoffMs, retryIf }`)**: Customize initial delay, multiplier factor, maximum backoff cap, and selective error filtering.
- **Selective Retry Predicates (`retryIf`)**: Only retry transient errors (e.g. `(err) => err.status === 429 || err.code === 'ECONNRESET'`) while immediately failing on permanent errors like bad credentials.
- **Cancellation & Timeout Safe**: If a client cancels or the tool timeout expires while the server is sleeping between retries, the delay timer is aborted immediately without hanging the process.
- **Per-Call Overrides**: Override or disable retries for individual calls via `app.callTool(name, args, { retry: false })` or `{ retry: 5 }`.
- **Telemetry Integration**: Retries are automatically tracked in `analytics.getSnapshot().summary.totalRetries` and per-tool `metric.retries`, and logged at warning level (`tool:retry`).

```ts
// 1. Declarative shorthand: retry up to 3 times on failure
app.tool({
  name: "fetch_external_weather",
  inputSchema: { city: "string" },
  retry: 3,
  async handler({ city }) {
    return await weatherApi.getForecast(city);
  }
});

// 2. Fine-grained configuration with error filter
app.tool({
  name: "query_upstream_database",
  retry: {
    attempts: 4,
    backoffMs: 200,      // First retry after 200ms
    factor: 2,           // 200ms -> 400ms -> 800ms -> 1600ms
    maxBackoffMs: 5000,  // Cap backoff at 5 seconds
    retryIf: (err) => err.isTransient === true // Don't retry validation or auth errors
  },
  async handler(args) {
    return await db.query(args);
  }
});

// 3. Programmatic override (bypass retries)
await app.callTool("fetch_external_weather", { city: "London" }, { retry: false });
```

### Smart Input Coercion & Schema Defaults

Smaller, open-source, or cost-efficient LLMs (e.g. Llama 3, Mistral, Gemma, GPT-4o-mini, Claude Haiku) often pass stringified numbers (`"42"` instead of `42`), stringified booleans (`"false"` instead of boolean `false`), stringified JSON objects/arrays, or omit optional fields.

`mcponce` provides zero-dependency **Smart Input Coercion & Schema Defaults**:

- **Boolean String Safety**: In JavaScript, `Boolean("false")` evaluates to `true`. `mcponce`'s coercion correctly maps `"false"`, `"0"`, `"no"`, and `"off"` to boolean `false`, and `"true"`, `"1"`, `"yes"`, `"on"` to `true`.
- **Numeric Coercion**: Automatically coerces numeric strings (`"42"`, `"3.14"`, `"-10"`) into JavaScript numbers.
- **JSON Object & Array Parsing**: Coerces stringified JSON (`'{"key": "val"}'` or `'["a", "b"]'`) into parsed objects and arrays, and wraps single values into `[val]` when an array is expected.
- **Extended Schema Properties**: Define defaults, descriptions, and coercion directly in `inputSchema`:
  ```ts
  inputSchema: {
    page: { type: "number", default: 1, description: "Page number" },
    limit: { type: "number", default: 25, description: "Items per page" },
    activeOnly: { type: "boolean", default: true }
  }
  ```
- **Flexible Activation**:
  - **Tool-Level**: `app.tool({ name: "...", coerceInputs: true, ... })`.
  - **Server-Level**: `createMcpServer({ coerceInputs: true })` or via env `MCP_COERCE_INPUTS=true`.
  - **Property-Level**: `page: { type: "number", coerce: true }`.
  - **Per-Call Override**: `app.callTool(name, args, { coerceInputs: false })` (bypass) or `{ coerceInputs: true }` (enable).
- **Clean JSON Schema Advertising**: The underlying base type (`"type": "number"`, `"type": "boolean"`) and descriptions/defaults are preserved in JSON Schema advertised to clients over `tools/list`.

```ts
// 1. Tool with automatic input coercion and defaults
app.tool({
  name: "search_users",
  description: "Searches users with smart type coercion",
  coerceInputs: true,
  inputSchema: {
    page: { type: "number", default: 1, description: "Page number" },
    limit: { type: "number", default: 20, description: "Items per page" },
    activeOnly: { type: "boolean", default: true },
    tags: { type: "array", default: [] }
  },
  async handler({ page, limit, activeOnly, tags }) {
    // Guarantees: page is number (1), limit is number (20), activeOnly is boolean (true), tags is Array
    return await db.findUsers({ page, limit, activeOnly, tags });
  }
});

// Calling with stringified LLM inputs works seamlessly:
await app.callTool("search_users", {
  page: "2",
  limit: "50",
  activeOnly: "false",
  tags: '["admin", "developer"]'
});
```

### Real-Time Progress Reporting (`reportProgress`)

Long-running tools (e.g. file downloads, batch data migrations, AI embeddings, scraping, database indexing) need to communicate ongoing progress to clients before final completion so users and LLMs aren't left waiting blindly.

`mcponce` provides built-in, zero-dependency **Real-Time Progress Reporting**:

- **Official MCP Protocol Compliance**: When an MCP client (Claude Desktop, Cursor, Antigravity) requests progress via `_meta: { progressToken: "..." }`, `mcponce` automatically dispatches standard `notifications/progress` JSON-RPC messages over the active SSE/HTTP or stdio stream.
- **Unified Dual-Signature API**: Both `context.reportProgress(...)` and `extra.reportProgress(...)` support positional and object formats:
  - `await context.reportProgress(current, total, message)`
  - `await context.reportProgress({ progress: current, total, message })`
- **Programmatic Live Callbacks**: Pass `onProgress` to `app.callTool(name, args, { onProgress: (p) => ... })` to stream live updates in Node.js scripts or unit tests.
- **Inter-Tool Progress Forwarding**: When a parent tool calls a sub-tool, it can listen to the sub-tool's progress events via `context.callTool(..., { onProgress })` and aggregate or re-broadcast them.
- **Interactive CLI Terminal Display**: Running `mcponce call <tool-name>` renders live progress indicators and percentages on `stderr` (e.g. `[Progress sync_data] 45/100 (45%) - Syncing user records`), keeping `stdout` completely clean for piped JSON or output data. Supports `--no-progress` to suppress rendering.
- **Safe & Non-Blocking**: Progress reporting never throws or disrupts execution even if a client disconnects or an `onProgress` callback fails.

```ts
// 1. Tool reporting progress during execution
app.tool({
  name: "batch_process_records",
  description: "Processes records in chunks with live progress updates",
  inputSchema: { totalRecords: "number" },
  async handler({ totalRecords }, context) {
    for (let i = 1; i <= totalRecords; i++) {
      // Positional syntax: (progress, total, statusMessage)
      await context.reportProgress?.(i, totalRecords, `Processing record #${i}`);
      
      // Or object syntax:
      // await context.reportProgress?.({ progress: i, total: totalRecords, message: `Record #${i}` });
    }

    return { processed: totalRecords, success: true };
  }
});

// 2. Programmatic invocation with live onProgress listener
const result = await app.callTool("batch_process_records", { totalRecords: 100 }, {
  onProgress: (report) => {
    console.log(`[Live Progress] ${report.tool}: ${report.progress}/${report.total} - ${report.message}`);
  }
});

// 3. Running from CLI with live terminal progress indicator:
// $ mcponce call batch_process_records --totalRecords 50
// [Progress batch_process_records] 50/50 (100%) - Processing record #50
```

### Lightweight Middleware & Interceptors (`app.use`)

`mcponce` features a zero-dependency, Koa/Hono-style **Onion Middleware Subsystem** that intercepts tool executions. Use middleware for authentication, authorization guards, global request logging, argument mutation, context enrichment, custom rate-limiting, error fallbacks, and response masking:

- **Onion Model Execution**: Middlewares follow the standard `async (ctx, next) => { ... }` signature. Calling `await next()` passes control to downstream middleware and the final tool handler, then unwinds back up the stack.
- **Multi-Level Scope**:
  - **Global**: `app.use(handler)` intercepts every tool call on the server.
  - **Pattern / Filtered**: `app.use('admin_*', handler)`, `app.use(['read', 'write'], handler)`, or `app.use(/^query_/, handler)`.
  - **Tool-Level**: `app.tool({ name: 'x', middleware: [auth, rateLimiter], ... })` attaches middleware exclusively to a specific tool.
  - **Server Config**: `createMcpServer({ middleware: [...] })` registers initial middleware at server initialization.
- **Full Pipeline Control**:
  - **Argument Mutation**: Mutate or inject parameters in `ctx.args` before the tool handler runs.
  - **Context Enrichment**: Attach session tokens, database clients, or authenticated user info onto `ctx.context`.
  - **Early Short-Circuiting**: Return cached data or mock responses without invoking downstream handlers.
  - **Error Interception & Recovery**: Wrap `await next()` in `try ... catch` to transform errors into user-friendly responses or fallback values.
  - **Response Transformation**: Inspect or redact sensitive properties from the returned tool output.
- **Universal Coverage**: Works identically across remote MCP clients (HTTP/SSE, stdio), programmatic invocations (`app.callTool`), inter-tool calls (`context.callTool`), and CLI calls (`mcponce call`).

```ts
import { createMcpServer } from "mcponce";

const app = createMcpServer({ name: "secure-api-server" });

// 1. Global Timing & Audit Logging Middleware
app.use(async (ctx, next) => {
  const start = Date.now();
  console.log(`[Audit] Starting execution of tool: ${ctx.tool}`);
  
  const result = await next();
  
  console.log(`[Audit] Completed ${ctx.tool} in ${Date.now() - start}ms`);
  return result;
});

// 2. Authentication Guard on Admin Tools (Pattern-based)
app.use("admin_*", async (ctx, next) => {
  if (!ctx.args.apiKey || ctx.args.apiKey !== process.env.ADMIN_API_KEY) {
    throw new Error("Unauthorized: Valid admin apiKey required");
  }
  return next();
});

// 3. Context Enrichment & Input Normalization Middleware
app.use(async (ctx, next) => {
  // Attach authenticated identity to shared context
  ctx.context.user = { id: 42, role: "developer" };
  
  // Normalize string arguments
  if (typeof ctx.args.query === "string") {
    ctx.args.query = ctx.args.query.trim().toLowerCase();
  }
  return next();
});

// 4. Tool-Specific Middleware
const confirmGuard = async (ctx, next) => {
  if (!ctx.args.confirmed) {
    return { status: "aborted", message: "Operation requires confirmation" };
  }
  return next();
};

app.tool({
  name: "admin_purge_database",
  middleware: [confirmGuard],
  handler: async (args, context) => {
    // context.user is accessible here
    return { purgedBy: context.user.id };
  }
});
```

### Tool Analytics & Telemetry

`mcponce` automatically collects in-memory telemetry with zero performance overhead:

- **Invocation Counts & Durations**: Tracks total, successful, failed, timeout, and cancellation counts, as well as `minDurationMs`, `maxDurationMs`, `avgDurationMs`, and `lastDurationMs` for each tool.
- **Inter-Tool Call Graph**: Automatically maps which tools call which other tools (`compound_calc ──(x12)──> calculate`).
- **Recent Invocations Feed**: Capped circular buffer of recent executions with millisecond durations, statuses, and caller origins.
- **Multi-Channel Access**:
  - **CLI**: `node server.js analytics` renders a formatted terminal dashboard table.
  - **HTTP Endpoints**: `GET /analytics` returns full telemetry JSON; `GET /info` includes high-level totals.
  - **Programmatic**: `app.getAnalytics()` and `app.resetAnalytics()`.
  - **MCP Clients**: Any connected client can inspect the built-in `system://analytics` resource.

```ts
const analytics = app.getAnalytics();
console.log(`Total calls: ${analytics.summary.totalInvocations}`);
console.log(`Average duration: ${analytics.summary.averageExecutionTimeMs}ms`);
console.log(analytics.tools["calculate"]);
```

### Prometheus & OpenTelemetry Metrics (`GET /metrics`)

`mcponce` exposes standard Prometheus 0.0.4 text exposition format metrics out of the box for Kubernetes, Grafana, Datadog, and Prometheus scrapers:

- **HTTP Scrape Endpoint**: `GET /metrics` (`Content-Type: text/plain; version=0.0.4; charset=utf-8`)
- **Programmatic Access**: `app.getMetrics()` returns the full Prometheus metric string.
- **Built-in MCP Resource**: `system://metrics` allows connected AI clients to read live Prometheus counters.

Exposed standard metrics:
- `mcp_server_info{server="...",version="..."} 1`
- `mcp_server_uptime_seconds{server="..."} <seconds>`
- `mcp_active_sessions{server="..."} <gauge>`
- `mcp_sessions_total{server="..."} <counter>`
- `mcp_tool_invocations_total{server="...",status="success|error|timeout|cancelled"} <counter>`
- `mcp_tool_calls_total{server="...",tool="...",status="..."} <counter>`
- `mcp_tool_duration_seconds_total{server="...",tool="..."} <counter>`
- `mcp_tool_duration_seconds_avg{server="...",tool="..."} <gauge>`
- `mcp_tool_cache_hits_total{server="...",tool="..."} <counter>`
- `mcp_tool_retries_total{server="...",tool="..."} <counter>`
- `mcp_inter_tool_calls_total{server="...",caller="...",target="..."} <counter>`
- `mcp_cache_entries{server="..."} <gauge>`
- `mcp_cache_hits_total{server="..."} <counter>`
- `mcp_cache_misses_total{server="..."} <counter>`
- `mcp_cache_evictions_total{server="..."} <counter>`

```ts
// Scrape directly from code or test:
const metricsString = app.getMetrics();
console.log(metricsString);
```

## Client Configuration

Add to your MCP client config (e.g. `claude_desktop_config.json`, `cursor.json`). You can pass `--background` (or `-b`) directly as an argument:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/my-mcp.js", "--background"]
    }
  }
}
```

## Standalone Single-Executable Operation

`mcponce` is built first and foremost for **single-executable standalone operation**:

- You don't need any daemon or central manager running.
- Simply run your file: `node my-mcp.js` (or compile it to a standalone binary with `bun build --compile`, `pkg`, or `sea`).
- Point Claude Desktop, Cursor, or Antigravity directly to the file.
- The file automatically starts the background HTTP server on demand, single-instance coordinates, proxies stdio safely, and cleanly terminates when the client disconnects.

### Standalone CLI Commands

You can test tools and run diagnostics directly on any individual server file without the central CLI or opening Claude/Cursor:

```bash
node my-mcp.js tools                      # List all registered tools, descriptions, and schemas
node my-mcp.js call <tool> [params...]    # Execute a tool directly with CLI flags or JSON
node my-mcp.js call <tool> --help         # View detailed parameter schema and usage example
node my-mcp.js info                       # Inspect running status, PID, port, active sessions
node my-mcp.js analytics                  # View tool execution metrics and call graph
node my-mcp.js start                      # Start in background (if background: true configured)
node my-mcp.js stop                       # Stop the running server instance
node my-mcp.js restart                    # Restart the server instance
node my-mcp.js logs [count]               # View recent server logs
node my-mcp.js --dev                      # Run with diagnostic logs piped to stderr
node my-mcp.js --help                     # Show help
```

#### Direct Tool Invocation & Testing via CLI

You can execute any tool directly from the terminal without setting up an MCP client:

```bash
# 1. Discover registered tools and their parameter types
node my-mcp.js tools

# 2. Inspect a specific tool's parameter schema and usage example
node my-mcp.js call calculate --help

# 3. Call tool using named flags with automatic type casting
node my-mcp.js call calculate --operation add --a 10 --b 25
node my-mcp.js call hello --name Alice

# 4. Call tool with an inline JSON payload (or mix with flag overrides)
node my-mcp.js call calculate '{"operation": "multiply", "a": 6, "b": 7}'
node my-mcp.js call calculate '{"operation": "add", "a": 10}' --b 20

# 5. Output raw JSON for scripts, automation, or piping to jq
node my-mcp.js call calculate --operation add -a 10 -b 25 --json | jq .result
```

---

## Background Execution with Unitup (Optional)

`mcponce` supports running the shared MCP server as a detached background service using [Unitup](https://github.com/litepacks/unitup).

You can enable background mode in **3 convenient ways**:

1. **Via CLI parameter (`--background` / `-b`)** — *Zero code changes needed*:
   ```bash
   node server.js --background
   ```
   Or in your MCP client config (e.g. `claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "my-server": {
         "command": "node",
         "args": ["/path/to/server.js", "--background"]
       }
     }
   }
   ```

2. **Via Server Configuration (`background: true`)**:
   ```ts
   const app = createMcpServer({
     name: "browsertrack",
     background: true
   });

   app.run();
   ```

3. **Programmatically (`app.start({ background: true })`)**:
   ```ts
   const app = createMcpServer("browsertrack");

   await app.start({ background: true });   // Starts or reuses background server
   await app.stop({ background: true });    // Stops background process and cleans runtime state
   await app.restart({ background: true }); // Restarts background process and waits for /health
   ```

### Behavior & Architecture

- **Default (`background: false` or omitted)**: Uses the standard native on-demand lifecycle.
- **Enabled (via CLI `--background`, `background: true`, or `app.start({ background: true })`)**:
  - The client executable checks for an existing healthy background instance.
  - If none is running, it acquires the startup lock and uses **Unitup** to spawn the detached background server.
  - Waits for `GET /health` verification before connecting as a stdio bridge.
  - When the initial client (e.g. Claude) disconnects, **the background server remains alive** for other clients (Cursor, Antigravity, VS Code).
  - Multiple distinct applications (e.g. `browsertrack`, `softscope`, `recallite`) each run their own independent background singleton.
- **Source of Truth**: `mcponce` remains the sole authority for health verification, atomic locking, dynamic port discovery, and runtime metadata. Unitup is strictly an internal process-management detail.
- **Optional Dependency**: Unitup is only loaded when background mode is active. If enabled without Unitup installed, a clear error guides the user:
  ```text
  Background mode requires Unitup, but Unitup is not installed.

  Install it with:

  npm install unitup
  ```
- **Logs**: Unitup stdout and stderr logs are saved directly in `app.getLogDirectory()` (`<dataDir>/logs/unitup.stdout.log`).

---

## Central Management CLI (`mcponce`)

As an **optional addition**, `mcponce` comes with a global CLI that tracks all local MCP servers created on your machine in a lightweight JSON registry (`~/.mcponce/servers.json` or OS equivalent):

```bash
# List all registered MCP servers, statuses, PIDs, and ports
npx mcponce list

# Auto-configure server into Claude Desktop or Cursor
npx mcponce install ./server.js
npx mcponce install my-server claude
npx mcponce uninstall my-server claude

# Inspect detailed metrics and active sessions
npx mcponce status
npx mcponce status my-server

# Discover tools available on any running server
npx mcponce tools my-server

# Invoke a tool on a running server directly with CLI flags or JSON
npx mcponce call my-server calculate --operation add -a 10 -b 20
npx mcponce call my-server hello --name Alice

# View real-time tool analytics, execution stats, latencies, and call graph
npx mcponce analytics my-server
npx mcponce analytics my-server --json

# View logs of any server from anywhere
npx mcponce logs my-server 100

# Stop a running server (or all servers)
npx mcponce stop my-server
npx mcponce stop --all

# Clean up stopped servers from registry
npx mcponce clean
```

### Opt-out / Isolated Mode

If you do not want an individual server to register in the central `servers.json`, you can disable it either in code or via environment variable:

```ts
const app = createMcpServer({
  name: "isolated-mcp",
  registerInCentral: false // Operates 100% standalone and isolated
});
```

Or run with:

```bash
MCP_DISABLE_REGISTRY=1 node my-mcp.js
```

## Application Data and Logs

Runtime metadata (`runtime.json`, `instance.lock`) and logs are saved per-server in:

- **macOS**: `~/Library/Application Support/<name>/logs/`
- **Linux**: `$XDG_STATE_HOME/<name>/logs/` or `~/.local/state/<name>/logs/`
- **Windows**: `%LOCALAPPDATA%\<name>\logs\`

The central registry is stored at:
- **macOS/Linux**: `~/.mcponce/servers.json` (or `$XDG_STATE_HOME/mcponce/servers.json`)
- **Windows**: `%LOCALAPPDATA%\mcponce\servers.json`

## License

MIT

