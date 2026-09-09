#!/usr/bin/env node
import { createMcpServer } from '../../src/index.js';

// 1. Single Parameter Initialization
// You only need to pass the server name as a string:
const app = createMcpServer('quick-mcp');

// Add tools
app.tool({
  name: 'ping',
  description: 'Ping-pong health check',
  inputSchema: {},
  async handler() {
    // Plain objects are automatically wrapped into valid MCP CallToolResult
    return {
      reply: 'pong',
      timestamp: new Date().toISOString()
    };
  }
});

app.tool({
  name: 'echo',
  description: 'Echo back a message',
  inputSchema: {
    message: 'string'
  },
  async handler({ message }) {
    // Direct string returns are also automatically wrapped
    return `Echo: ${message}`;
  }
});

// Run single-executable MCP server / stdio bridge
//
// How to run:
// 1. Standard on-demand (in-process shared server):
//    npx tsx examples/quickstart/server.ts
//
// 2. Detached background process (1 CLI parameter):
//    npx tsx examples/quickstart/server.ts --background
//
// 3. Standalone file management commands:
//    npx tsx examples/quickstart/server.ts start
//    npx tsx examples/quickstart/server.ts info
//    npx tsx examples/quickstart/server.ts logs
//    npx tsx examples/quickstart/server.ts stop
//    npx tsx examples/quickstart/server.ts restart
app.run();
