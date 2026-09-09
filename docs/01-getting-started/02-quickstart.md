---
title: Quickstart Guide
description: Learn how to install mcponce, build your first server, and connect it to Claude Desktop or Cursor.
---

# Quickstart Guide

Get up and running with `mcponce` in less than 2 minutes.

---

## 📦 Installation

:::tabs group="package-manager"
::tab npm
```bash
npm install mcponce
```
::tab pnpm
```bash
pnpm add mcponce
```
::tab yarn
```bash
yarn add mcponce
```
::tab bun
```bash
bun add mcponce
```
:::

Requirements:
- **Node.js**: v20.0.0 or higher
- **Bun**: v1.1.0 or higher (optional)

---

## 🛠️ Creating Your Server

Create a file named `server.ts` (or `server.js`):

```ts
import { createMcpServer } from 'mcponce';

// 1. Initialize the MCP application
const app = createMcpServer({
  name: 'my-assistant',
  version: '1.0.0',
  port: 8080 // optional: defaults to 3000 or dynamic open port
});

// 2. Define your first tool with shorthand schema
app.tool({
  name: 'greet_user',
  description: 'Returns a friendly greeting with user status',
  inputSchema: {
    username: 'string',
    vip: { type: 'boolean', default: false }
  },
  handler: ({ username, vip }) => {
    return {
      message: `Hello ${vip ? 'VIP member' : ''} ${username}! Welcome back.`,
      timestamp: new Date().toISOString()
    };
  }
});

// 3. Define a mathematical calculation tool with caching
app.tool({
  name: 'fibonacci',
  description: 'Calculates the Nth Fibonacci number with in-memory caching',
  inputSchema: {
    n: { type: 'number', default: 10 }
  },
  cache: { ttlMs: 60_000 },
  handler: ({ n }) => {
    function fib(num: number): number {
      if (num <= 1) return num;
      let a = 0, b = 1;
      for (let i = 2; i <= num; i++) {
        const c = a + b;
        a = b;
        b = c;
      }
      return b;
    }
    return { n, result: fib(n) };
  }
});

// 4. Run the server
app.run();
```

---

## 🏃 Running the Server

:::tabs group="runners"
::tab Node.js (Foreground)
```bash
node server.js
```
The server will start and print connection details:
```
✓ MCP server "my-assistant" (v1.0.0) running in foreground
  HTTP: http://127.0.0.1:8080
  MCP Endpoint: http://127.0.0.1:8080/mcp
  Health: http://127.0.0.1:8080/health
  Metrics: http://127.0.0.1:8080/metrics
```

::tab Background Daemon (--background)
```bash
node server.js --background
```
Or shorthand flag:
```bash
node server.js -b
```
`mcponce` will automatically coordinate with the [Unitup](https://github.com/litepacks/unitup) daemon. If an instance is already running, it attaches immediately without port conflicts!
:::

---

## 🔌 Connecting to LLM Clients

### ⚡ One-Command Automatic Setup (Recommended)

Instead of editing configuration files manually, run the auto-installer:

```bash
# Automatically configures both Claude Desktop and Cursor!
node server.js install
```
*(Or specify `node server.js install claude` or `node server.js install cursor`). See [Client Auto-Installer](/runtime-and-cli/client-auto-installer) for details.*

---

### Manual Configuration

If you prefer to configure clients manually:

#### Claude Desktop

Open your Claude Desktop configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add your `mcponce` server configuration:

```json
{
  "mcpServers": {
    "my-assistant": {
      "command": "node",
      "args": ["/absolute/path/to/server.js", "--background"]
    }
  }
}
```

:::tip Why use `--background` with Claude Desktop?
Whenever Claude Desktop spawns an MCP process, `--background` coordinates all requests to a single background daemon. When Claude restarts or opens multiple windows, your database connections and caches remain warm!
:::

#### Cursor / Antigravity

In Cursor:
1. Open **Settings** ➔ **Features** ➔ **MCP Servers**.
2. Click **Add New MCP Server**.
3. Choose **Type: command**.
4. Command: `node /path/to/server.js --background`.

---

## 🧪 Testing Tools via Terminal (No LLM Required!)

`mcponce` comes with a built-in parametric CLI caller:

```bash
# List all registered tools and parameter signatures:
npx mcponce call --list

# Call greet_user:
npx mcponce call greet_user --username=Ahmet --vip=true

# Call fibonacci with JSON output:
npx mcponce call fibonacci --n 20 --json
```

---

## Next Steps

- Learn how to **[Define Tools & Schemas](/core-features/defining-tools)** with Zod or shorthand schemas.
- Explore **[Inter-Tool Invocations](/core-features/inter-tool-calling)** to compose tools together.
- Inspect **[Observability & Prometheus](/observability/prometheus-metrics)** to scrape metrics in Grafana.
