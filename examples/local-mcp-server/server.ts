#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, z } from 'mcponce';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const configuredPort = Number(process.env.MCP_SERVER_PORT ?? 3210);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 3210;

const app = createMcpServer({
  name: 'local-example-mcp',
  version: '1.0.0',
  host: '127.0.0.1',
  port,
  background: true,
  dataDir: path.join(projectDir, '.mcponce-data'),
  registerInCentral: false
});

app.tool({
  name: 'greet',
  description: 'Greets a person in Turkish or English',
  inputSchema: z.object({
    name: z.string().min(1).describe('Name of the person to greet'),
    language: z.enum(['tr', 'en']).default('tr').describe('Greeting language')
  }),
  async handler({ name, language }) {
    return language === 'tr' ? `Merhaba, ${name}!` : `Hello, ${name}!`;
  }
});

app.tool({
  name: 'add',
  description: 'Adds two numbers and returns their sum',
  inputSchema: z.object({
    a: z.number().describe('First number'),
    b: z.number().describe('Second number')
  }),
  async handler({ a, b }) {
    return { a, b, sum: a + b };
  }
});

app.resource({
  uri: 'local-example://about',
  name: 'About this server',
  description: 'Basic information about the local example MCP server',
  mimeType: 'application/json',
  async handler(uri: URL) {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              name: 'local-example-mcp',
              transport: 'Streamable HTTP and stdio',
              endpoint: `http://127.0.0.1:${port}/mcp`
            },
            null,
            2
          )
        }
      ]
    };
  }
});

await app.run();
