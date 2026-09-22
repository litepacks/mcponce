# Local MCP Server Example

This folder is a standalone local project that consumes the parent `mcponce`
package through a local `file:` dependency. It exposes two tools:

- `greet`: returns a Turkish or English greeting.
- `add`: adds two numbers.

## Run locally

Requires Node.js 20 or newer.

```bash
cd examples/local-mcp-server
npm install
npm run build:framework

# List the tools
npm run tools

# Call tools directly
npm run call -- greet --name Ahmet --language tr
npm run call -- add --a 12 --b 30

# Start the persistent background service
npm start
npm run info
```

Once started, open `http://127.0.0.1:3210/inspect` in a browser. The MCP
Streamable HTTP endpoint is `http://127.0.0.1:3210/mcp`.

```bash
npm run stop
```

`mcponce` installs a Unitup-managed macOS LaunchAgent for this example. It
starts automatically when the user logs in; `npm run stop` stops and uninstalls
that service. Codex uses the same background instance over its stdio bridge.

Set a different port before the first start when needed:

```bash
MCP_SERVER_PORT=4321 npm start
```

## MCP client configuration

Use absolute paths for Node, the local `tsx` loader, and `server.ts`:

```json
{
  "mcpServers": {
    "local-example": {
      "command": "/absolute/path/to/node",
      "args": [
        "--import",
        "/absolute/path/to/mcponce/examples/local-mcp-server/node_modules/tsx/dist/loader.mjs",
        "/absolute/path/to/mcponce/examples/local-mcp-server/server.ts"
      ]
    }
  }
}
```

The server keeps its runtime files and logs under `.mcponce-data/` in this
folder. That directory is ignored by the repository's existing `.gitignore`.
