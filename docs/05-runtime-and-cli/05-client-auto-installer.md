---
title: Client Auto-Installer
description: One-command configuration of mcponce servers into Claude Desktop, Cursor, and Antigravity IDE.
---

# Client Auto-Installer

Configuring MCP servers manually by hunting down JSON configuration files on disk, copying absolute file paths, and formatting JSON strings is tedious and error-prone.

**mcponce** provides a built-in **Client Auto-Installer** that discovers your local AI client configuration files and configures your server in a single command.

---

## 1. Quick Installation from Server Script

You can install any `mcponce` server directly using its own script:

:::tabs group="installer-modes"
::tab Install to All Clients (Default)
```bash
node server.js install
```
Auto-configures both **Claude Desktop** and **Cursor** to run with `--background` mode.

::tab Install to Claude Desktop Only
```bash
node server.js install claude
```

::tab Install to Cursor Only
```bash
node server.js install cursor
```

::tab Project-Level Cursor (.cursor/mcp.json)
```bash
node server.js install cursor --project
```
:::

Output:
```
✔ Configured "my-tools" in MCP client(s):

  claude: /Users/username/Library/Application Support/Claude/claude_desktop_config.json
    Command: node /Users/username/projects/agent/server.js --background

  cursor: /Users/username/Library/Application Support/Cursor/User/globalStorage/mcp.json
    Command: node /Users/username/projects/agent/server.js --background
```

---

## 2. Global CLI Installation (`mcponce install`)

If using the global `mcponce` CLI, you can point to any local script file or registered server name:

```bash
# Install by script path
npx mcponce install ./server.ts claude

# Install from a registered central server
npx mcponce install my-agent cursor
```

:::note TypeScript Auto-Detection
When targeting a `.ts` file (e.g. `server.ts`), the installer automatically configures `npx tsx <path> --background` so your server runs natively without requiring manual compilation.
:::

---

## 3. Supported Clients & Configuration Paths

The auto-installer automatically resolves paths according to your operating system:

| Client | Platform | Standard Location |
| :--- | :--- | :--- |
| **Claude Desktop** | **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| | **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |
| | **Linux** | `~/.config/Claude/claude_desktop_config.json` |
| **Cursor (Global)** | **macOS** | `~/Library/Application Support/Cursor/User/globalStorage/mcp.json` |
| | **Windows** | `%APPDATA%\Cursor\User\globalStorage\mcp.json` |
| | **Linux** | `~/.config/Cursor/User/globalStorage/mcp.json` |
| **Cursor (Project)**| **All** | `<project-root>/.cursor/mcp.json` (via `--project`) |
| **Antigravity** | **All** | `~/.gemini/antigravity-ide/mcp_config.json` |

---

## 4. Uninstalling Servers

Remove a server from your client configuration with `uninstall`:

:::tabs group="uninstall-modes"
::tab From Server Script
```bash
# Remove from all clients
node server.js uninstall

# Remove from Claude Desktop only
node server.js uninstall claude
```

::tab From Global CLI
```bash
npx mcponce uninstall my-agent cursor
```
:::

---

## 5. CLI Flags & Options

| Flag | Description |
| :--- | :--- |
| `--dry-run` | Preview what would be written without modifying any files on disk. |
| `--project` | Target the local workspace `.cursor/mcp.json` instead of global settings. |
| `--no-background` | Disables the default `--background` flag on the server command. |
| `--config-path <path>` | Override target file with a custom config path. |

---

## 6. Programmatic API

You can also install or inspect client configurations programmatically in test suites or deployment scripts:

```typescript
import {
  installClientConfig,
  uninstallClientConfig,
  getClientConfigPath
} from 'mcponce';

// Get config path for Claude Desktop on current OS
const claudePath = getClientConfigPath('claude');

// Programmatically install
const results = installClientConfig({
  serverName: 'custom-db-agent',
  entrypoint: './dist/server.js',
  client: 'all',
  background: true,
  env: {
    NODE_ENV: 'production',
    DB_PORT: '5432'
  }
});

// Programmatically remove
uninstallClientConfig({
  serverName: 'custom-db-agent',
  client: 'claude'
});
```
