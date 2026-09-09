import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TestMcpClient {
  private child: ChildProcess;
  private pendingRequests = new Map<
    number | string,
    { resolve: (val: any) => void; reject: (err: any) => void }
  >();
  private buffer = '';
  public stderrLogs: string[] = [];

  constructor(scriptPath: string, args: string[]) {
    this.child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stdout?.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    this.child.stderr?.on('data', (chunk) => {
      this.stderrLogs.push(chunk.toString('utf-8'));
    });
  }

  private processBuffer() {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve } = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // Ignored or invalid line
      }
    }
  }

  async sendRequest(method: string, params: any = {}, id = Math.floor(Math.random() * 100000)): Promise<any> {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    }) + '\n';

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.child.stdin?.write(payload);
    });
  }

  async sendNotification(method: string, params: any = {}): Promise<void> {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    }) + '\n';
    this.child.stdin?.write(payload);
  }

  close(): void {
    try {
      this.child.stdin?.end();
      this.child.kill();
    } catch {}
  }
}

describe('stdio bridge and multiple clients', () => {
  let testDir: string;
  const clients: TestMcpClient[] = [];

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-stdio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    for (const c of clients) {
      c.close();
    }
    clients.length = 0;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('allows multiple independent stdio clients to initialize and invoke tools through the shared server', async () => {
    const scriptPath = path.join(__dirname, 'fixtures', 'stdio-server.mjs');

    // Launch client 1 (this will start the shared HTTP server and bridge stdio)
    const client1 = new TestMcpClient(scriptPath, [testDir]);
    clients.push(client1);

    const init1 = await client1.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'client-1', version: '1.0.0' }
    });
    expect(init1.result).toBeDefined();
    expect(init1.result.serverInfo.name).toBe('stdio-test-app');

    await client1.sendNotification('notifications/initialized');

    // Call greet tool from client 1
    const call1 = await client1.sendRequest('tools/call', {
      name: 'greet',
      arguments: { name: 'Alice' }
    });
    expect(call1.result).toBeDefined();
    expect(call1.result.content[0].text).toBe('Hello Alice!');

    // Launch client 2 (this will discover the shared HTTP server and connect as a bridge)
    const client2 = new TestMcpClient(scriptPath, [testDir]);
    clients.push(client2);

    const init2 = await client2.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'client-2', version: '1.0.0' }
    });
    expect(init2.result).toBeDefined();
    expect(init2.result.serverInfo.name).toBe('stdio-test-app');

    await client2.sendNotification('notifications/initialized');

    // Call greet tool from client 2
    const call2 = await client2.sendRequest('tools/call', {
      name: 'greet',
      arguments: { name: 'Bob' }
    });
    expect(call2.result).toBeDefined();
    expect(call2.result.content[0].text).toBe('Hello Bob!');
  });
});
