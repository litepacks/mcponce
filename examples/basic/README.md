# Basic Example - Single-Executable MCP Server

This example demonstrates how to create a cross-platform MCP server running from a single executable file using `mcponce`.

## Server Code

```ts
import { createMcpServer } from "mcponce";

const app = createMcpServer({
  name: "hello-mcp",
  version: "0.1.0"
});

app.tool({
  name: "hello",
  description: "Return a greeting",
  inputSchema: {
    name: "string"
  },
  async handler({ name }) {
    return {
      content: [
        {
          type: "text",
          text: `Hello ${name}!`
        }
      ]
    };
  }
});

app.run();
```

## Client Configuration

Configure this MCP server directly in your MCP client settings (e.g., Claude Desktop, Cursor, Antigravity, or VS Code):

```json
{
  "mcpServers": {
    "hello": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"]
    }
  }
}
```

Or when running with `tsx` during development:

```json
{
  "mcpServers": {
    "hello": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/server.ts"]
    }
  }
}
```

## How It Works

1. When Claude, Cursor, or another client starts the executable, it communicates with the executable via `stdio`.
2. The executable automatically checks whether a local shared instance is already running.
3. If no server is running, it starts the shared local Hono HTTP server on a dynamic port (`port: 0`), holds an atomic lock, and bridges its stdio to it.
4. If a server is already running, it discovers the dynamic port via `runtime.json`, verifies its health via `GET /health`, and connects as a lightweight stdio bridge.
5. All connected clients share the exact same tool registry and application context.

## Application Data & Log Locations

Logs and runtime metadata (`runtime.json`, `instance.lock`) are stored in standard platform-specific application directories:

- **macOS:**
  `~/Library/Application Support/hello-mcp/logs/`
- **Linux:**
  `$XDG_STATE_HOME/hello-mcp/logs/` or `~/.local/state/hello-mcp/logs/`
- **Windows:**
  `%LOCALAPPDATA%\hello-mcp\logs\`

Inside the log directory:
- `current.log`: Active structured log stream.
- `YYYY-MM-DD.log`: Daily rotated log files (retained for 7 days by default).

### Overriding Directory Paths

You can override the data and log directories through API configuration:

```ts
createMcpServer({
  name: "hello-mcp",
  dataDir: "/custom/data/path",
  logging: {
    directory: "/custom/logs/path",
    retentionDays: 14
  }
});
```

Or via environment variables:

```bash
export MCP_SERVER_DATA_DIR="/custom/data/path"
export MCP_SERVER_LOG_DIR="/custom/logs/path"
```

## CLI Inspection & Tool Execution Commands

You can test tools, inspect the server status, or read logs from the terminal at any time without managing a daemon or opening Claude/Cursor:

```bash
# 1. Discover all registered tools and their parameter schemas
npx tsx examples/basic/server.ts tools

# 2. Execute a tool with named CLI parameters
npx tsx examples/basic/server.ts call calculate --operation add -a 10 -b 25

# 3. Execute a tool with an inline JSON payload
npx tsx examples/basic/server.ts call hello '{"name": "Alice"}'

# 4. View detailed parameter schema and usage instructions for a tool
npx tsx examples/basic/server.ts call calculate --help

# 5. Check server status, PID, port, and active sessions
npx tsx examples/basic/server.ts info

# 6. View the last 50 log entries
npx tsx examples/basic/server.ts logs
```
