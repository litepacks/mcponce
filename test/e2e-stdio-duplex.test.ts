import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');

describe('E2E Stdio Duplex: Claude Desktop & Cursor Protocol Simulation', () => {
  let tmpDir: string;
  let serverPath: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mcp-stdio-duplex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Link node_modules so dependencies resolve in the temporary directory
    try {
      fs.symlinkSync(
        path.resolve(__dirname, '../node_modules'),
        path.join(tmpDir, 'node_modules'),
        'junction'
      );
    } catch {}

    // package.json with ESM
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'stdio-e2e-project', type: 'module' }, null, 2),
      'utf-8'
    );

    // Realistic server entrypoint
    serverPath = path.join(tmpDir, 'server.js');
    const serverCode = `
import { createMcpServer, z } from '${path.join(distPath, 'index.js')}';

const app = createMcpServer({
  name: 'stdio-duplex-server',
  version: '1.0.0',
  port: 0,
  registerInCentral: false
});

app.tool({
  name: 'echo_msg',
  description: 'Echoes a message back',
  inputSchema: {
    message: 'string',
    repeat: 'number?'
  },
  handler: async ({ message, repeat }) => {
    const times = repeat || 1;
    return Array(times).fill(message).join(' ');
  }
});

app.tool({
  name: 'explode',
  description: 'Simulates a tool failure',
  handler: async () => {
    throw new Error('Exploded on purpose');
  }
});

await app.run();
`;
    fs.writeFileSync(serverPath, serverCode, 'utf-8');
  });

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('communicates over stdio and enforces strict STDOUT JSON-RPC cleanliness', async () => {
    // Spawn server process as Claude Desktop / Cursor does
    child = spawn(process.execPath, [serverPath], {
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test'
      }
    });

    const stdoutLines: string[] = [];
    const stderrChunks: string[] = [];
    let lineBuffer = '';

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          stdoutLines.push(trimmed);
        }
      }
    });

    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => {
      stderrChunks.push(chunk);
    });

    const sendJsonRpc = (msg: object) => {
      child!.stdin!.write(JSON.stringify(msg) + '\n');
    };

    const waitForResponse = async (id: number | string, timeoutMs = 6000): Promise<any> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (const rawLine of stdoutLines) {
          try {
            const parsed = JSON.parse(rawLine);
            if (parsed.id === id) {
              return parsed;
            }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(
        `Timeout waiting for response to id=${id}. Captured stdout: ${JSON.stringify(stdoutLines)}, stderr: ${stderrChunks.join('')}`
      );
    };

    // 1. Send initialize
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-desktop-sim', version: '0.1.0' }
      }
    });

    const initResp = await waitForResponse(1);
    expect(initResp.result.serverInfo.name).toBe('stdio-duplex-server');
    expect(initResp.result.protocolVersion).toBe('2024-11-05');

    // 2. Send initialized notification
    sendJsonRpc({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });

    // 3. Send tools/list
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });

    const toolsResp = await waitForResponse(2);
    expect(toolsResp.result.tools).toBeInstanceOf(Array);
    expect(toolsResp.result.tools.some((t: any) => t.name === 'echo_msg')).toBe(true);

    // 4. Send tools/call (successful tool)
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'echo_msg',
        arguments: { message: 'mcponce rocks', repeat: 3 }
      }
    });

    const callResp = await waitForResponse(3);
    expect(callResp.result.isError).toBeFalsy();
    expect(callResp.result.content[0].text).toBe('mcponce rocks mcponce rocks mcponce rocks');

    // 5. Send tools/call (failing tool)
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'explode',
        arguments: {}
      }
    });

    const errorResp = await waitForResponse(4);
    expect(errorResp.result.isError).toBe(true);
    expect(errorResp.result.content[0].text).toContain('Exploded on purpose');

    // -------------------------------------------------------------
    // 6. Strict STDOUT Cleanliness Assertion
    // Every single line emitted to stdout MUST be valid JSON-RPC!
    // Any random console.log corrupts Claude Desktop / Cursor stdio connection.
    // -------------------------------------------------------------
    expect(stdoutLines.length).toBeGreaterThanOrEqual(4);
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });
});
