---
title: Structured Logging
description: File-based daily log rotation, configurable retention, stderr streaming, and custom logger integration.
---

# Structured Logging

Reliable debugging of MCP servers requires consistent, structured logging that doesn't interfere with standard MCP stdio communication. 

**mcponce** provides an isolated, rotating file logger with automated retention policies and zero pollution of stdout.

---

## Configuring Logging

Configure the built-in logger in your server definition:

```typescript
import { createMcpServer } from 'mcponce';

const app = createMcpServer({
  name: 'file-service',
  logging: {
    level: 'info',           // 'debug' | 'info' | 'warn' | 'error'
    retentionDays: 14,       // Automatically delete logs older than 14 days
    logToStderr: true,       // Mirror logs to stderr (safe for MCP stdio)
    directory: './logs'      // Defaults to ~/.mcponce/logs/<server-name>
  }
});
```

:::warning Never Log to `stdout` in Stdio Mode
In MCP standard I/O mode, `stdout` is strictly reserved for JSON-RPC messages between the host and your server. Calling `console.log` directly into stdout corrupts the transport and disconnects Claude or Cursor. `mcponce` ensures internal logs are written to disk and stderr only.
:::

---

## Accessing Logs Programmatically

Inspect recent logs directly from code or test suites:

```typescript
// Get the active logs directory
const logDir = app.getLogDirectory();
console.log(`Writing logs to: ${logDir}`);

// Read the last 50 log lines
const recentLines = await app.readLogs(50);
console.log(recentLines.join('\n'));
```

---

## Custom Logger Integration

Integrate with existing application loggers (Pino, Winston, Roarr, or Bunyan) by passing the `logger` option:

```typescript
import pino from 'pino';
import { createMcpServer } from 'mcponce';

const pinoLogger = pino();

const app = createMcpServer({
  name: 'enterprise-server',
  // Adapter forwarding to your custom logger
  logger: {
    debug: (msg, meta) => pinoLogger.debug(meta, msg),
    info: (msg, meta) => pinoLogger.info(meta, msg),
    warn: (msg, meta) => pinoLogger.warn(meta, msg),
    error: (msg, meta) => pinoLogger.error(meta, msg)
  }
});
```
