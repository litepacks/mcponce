import { createMcpServer } from '../../src/index.js';

const dataDir = process.argv[2];

const app = createMcpServer({
  name: 'stdio-test-app',
  dataDir,
  port: 0
});

app.tool({
  name: 'greet',
  description: 'Greet someone',
  inputSchema: {
    name: 'string'
  },
  async handler({ name }) {
    return {
      content: [
        {
          type: 'text',
          text: `Hello ${name}!`
        }
      ]
    };
  }
});

app.run();
