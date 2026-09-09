#!/usr/bin/env node
import { createMcpServer } from '../../src/index.js';

// Create the MCP server application
// Can be initialized with 1 string parameter: createMcpServer('hello-mcp')
// Or with full configuration options:
const app = createMcpServer({
  name: 'hello-mcp',
  version: '0.1.0',
  // Can be enabled here (background: true) or via CLI parameter (--background / -b)
  background: false
});

// 1. Tool Example
app.tool({
  name: 'hello',
  description: 'Return a greeting',
  inputSchema: {
    name: 'string'
  },
  async handler({ name }) {
    // Standard MCP CallToolResult format
    return {
      content: [
        {
          type: 'text',
          text: `Hello ${name}!`
        }
      ]
    };
    // Tip: mcponce also supports simplified returns:
    // return `Hello ${name}!`;
  }
});

// Additional Tool Example: Math calculation with typed inputs and auto-normalized JSON return
app.tool({
  name: 'calculate',
  description: 'Perform math calculations (add, subtract, multiply, divide)',
  inputSchema: {
    operation: 'string', // 'add' | 'subtract' | 'multiply' | 'divide'
    a: 'number',
    b: 'number'
  },
  async handler({ operation, a, b }) {
    let result: number;
    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        if (b === 0) throw new Error('Cannot divide by zero');
        result = a / b;
        break;
      default:
        throw new Error(`Unknown operation "${operation}". Supported: add, subtract, multiply, divide`);
    }

    // mcponce automatically normalizes plain objects/strings into valid MCP content responses!
    return {
      operation,
      a,
      b,
      result
    };
  }
});

// Additional Tool Example: Calling another tool within a tool!
// You can access callTool directly from the context argument:
app.tool({
  name: 'compound_calculation',
  description: 'Demonstrates calling the "calculate" tool internally',
  inputSchema: {
    start: 'number',
    addAmount: 'number',
    multiplier: 'number'
  },
  async handler({ start, addAmount, multiplier }, { callTool }) {
    // 1. Call the "calculate" tool to add start + addAmount
    const step1 = await callTool('calculate', {
      operation: 'add',
      a: start,
      b: addAmount
    });

    // 2. Call the "calculate" tool again to multiply by multiplier
    const step2 = await callTool('calculate', {
      operation: 'multiply',
      a: step1.data.result,
      b: multiplier
    });

    return {
      step1: step1.data,
      finalResult: step2.data.result
    };
  }
});

// Additional Tool Example: System information with simplified return
app.tool({
  name: 'system_info',
  description: 'Returns basic system platform and memory stats',
  inputSchema: {},
  async handler() {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    };
  }
});

// Additional Tool Example: Timeout & Cancellation with AbortSignal
app.tool({
  name: 'cancellable_fetch',
  description: 'Fetches content with automatic timeout and client cancellation support',
  inputSchema: {
    url: 'string'
  },
  timeoutMs: 10000, // 10-second timeout for this tool (overrides server-level toolTimeoutMs)
  async handler({ url }, { signal }) {
    // If the client cancels (e.g. user clicks Stop in Cursor) or timeout occurs,
    // signal is automatically aborted and stops the HTTP fetch immediately!
    const response = await fetch(url, { signal });
    const text = await response.text();
    return {
      status: response.status,
      length: text.length,
      sample: text.slice(0, 150)
    };
  }
});

// Additional Tool Example: Sequential Execution & Mutex
// Invocations of this tool are queued in strict FIFO order to prevent concurrent conflicts
app.tool({
  name: 'sequential_job',
  description: 'Executes a stateful job with guaranteed single-execution (sequential: true)',
  inputSchema: {
    jobId: 'string'
  },
  sequential: true, // Only one invocation runs at a time; others wait in FIFO queue
  async handler({ jobId }) {
    // Simulate critical section work
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      jobId,
      status: 'completed',
      timestamp: Date.now()
    };
  }
});

// Additional Tool Example: In-Memory Response Caching
// Identical calls within the TTL return the cached result immediately without re-executing
app.tool({
  name: 'get_quote',
  description: 'Fetches a stock quote with in-memory caching (cache: { ttlMs: 30000 })',
  inputSchema: {
    symbol: 'string'
  },
  cache: { ttlMs: 30_000 }, // Caches responses for 30 seconds
  async handler({ symbol }) {
    return {
      symbol: symbol.toUpperCase(),
      price: 154.25,
      fetchedAt: new Date().toISOString()
    };
  }
});

// 2. Resource Example
app.resource({
  uri: 'info://server',
  name: 'Server Information',
  description: 'Returns server runtime info',
  mimeType: 'application/json',
  async handler(uri) {
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            name: 'hello-mcp',
            version: '0.1.0',
            runtime: 'mcponce'
          })
        }
      ]
    };
  }
});

// 3. Prompt Example
app.prompt({
  name: 'greet-user',
  description: 'A template to warmly greet a user',
  argsSchema: {
    userName: 'string'
  },
  async handler({ userName }) {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please give a warm welcome and greeting to ${userName}.`
          }
        }
      ]
    };
  }
});

// Run single-executable MCP server / stdio bridge
app.run();

