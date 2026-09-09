import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('concurrent startup (10 processes racing)', () => {
  let testDir: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    for (const child of children) {
      try {
        child.send('exit');
        child.kill();
      } catch {}
    }
    children.length = 0;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('coordinates 10 concurrent processes: 1 owner and 9 bridges sharing the same PID and port', async () => {
    const workerPath = path.join(__dirname, 'fixtures', 'worker.mjs');
    const NUM_PROCESSES = 10;

    const startPromises = Array.from({ length: NUM_PROCESSES }, () => {
      return new Promise<{ reused: boolean; role: string; pid: number; port: number }>((resolve, reject) => {
        const child = fork(workerPath, [testDir], {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        });
        children.push(child);

        child.on('message', (msg: any) => {
          resolve(msg);
        });

        child.on('error', (err) => {
          reject(err);
        });
      });
    });

    const results = await Promise.all(startPromises);

    expect(results.length).toBe(10);

    const owners = results.filter((r) => r.role === 'owner');
    const bridges = results.filter((r) => r.role === 'bridge');

    // Exactly one owner started the server
    expect(owners.length).toBe(1);
    expect(bridges.length).toBe(9);

    const expectedPid = owners[0].pid;
    const expectedPort = owners[0].port;

    expect(expectedPort).toBeGreaterThan(0);

    // All 10 discovered and report the exact same PID and port
    for (const res of results) {
      expect(res.pid).toBe(expectedPid);
      expect(res.port).toBe(expectedPort);
    }
  });
});
