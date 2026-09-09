import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMcpServer } from '../src/index.js';
import { InstanceCoordinator } from '../src/runtime/instance.js';
import { resolveConfig } from '../src/runtime/config.js';
import { LockManager } from '../src/runtime/lock.js';
import { StateManager } from '../src/runtime/state.js';
import { CentralRegistry } from '../src/registry/central.js';

describe('Resilience and Crash Scenarios', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-resilience-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('immediately recovers from a 0-byte (empty) instance.lock without delay', async () => {
    const lockPath = path.join(testDir, 'instance.lock');
    // Create an empty 0-byte lock file (simulating power failure / crash mid-file creation)
    fs.writeFileSync(lockPath, '');
    expect(fs.statSync(lockPath).size).toBe(0);

    const config = resolveConfig({
      name: 'zero-byte-test',
      dataDir: testDir,
      port: 0
    });

    const coordinator = new InstanceCoordinator(config);
    const start = Date.now();
    const role = await coordinator.ensureInstance();
    const duration = Date.now() - start;

    expect(role.role).toBe('owner');
    // Fast path recovery must happen in under 1 second (no waiting for maxWaitMs)
    expect(duration).toBeLessThan(1000);

    role.lockManager.release();
  });

  it('immediately recovers when instance.lock contains a dead PID', async () => {
    const lockPath = path.join(testDir, 'instance.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999998, name: 'dead-pid-test', createdAt: new Date().toISOString() })
    );

    const config = resolveConfig({
      name: 'dead-pid-test',
      dataDir: testDir,
      port: 0
    });

    const coordinator = new InstanceCoordinator(config);
    const start = Date.now();
    const role = await coordinator.ensureInstance();
    const duration = Date.now() - start;

    expect(role.role).toBe('owner');
    // Fast path recovery must happen in under 1 second
    expect(duration).toBeLessThan(1000);

    role.lockManager.release();
  });

  it('safely handles corrupt JSON across state and registry files', async () => {
    const statePath = path.join(testDir, 'runtime.json');
    const registryPath = path.join(testDir, 'servers.json');

    fs.writeFileSync(statePath, '{ this is not valid JSON !!! @@## }');
    fs.writeFileSync(registryPath, '<<< corrupt binary gibberish >>>');

    const stateManager = new StateManager(testDir);
    expect(stateManager.read()).toBeNull();

    const registry = new CentralRegistry(registryPath);
    const servers = await registry.getAll(false);
    expect(Array.isArray(servers)).toBe(true);
    expect(servers.length).toBe(0);

    // Registering a server should safely overwrite the corrupted file
    await registry.register({
      name: 'recovered-srv',
      version: '1.0.0',
      status: 'stopped',
      dataDir: testDir,
      logDir: testDir
    });

    const reloaded = await registry.getAll(false);
    expect(reloaded.length).toBe(1);
    expect(reloaded[0].name).toBe('recovered-srv');
  });

  it('covers all StateManager methods, path getter, invalid schema, and clean edge cases', () => {
    const subDir = path.join(testDir, 'deep', 'state-dir');
    const sm = new StateManager(subDir);
    expect(sm.path).toBe(path.join(subDir, 'runtime.json'));

    // Non-existent directory write creates directory
    sm.write({
      name: 'test-app',
      version: '1.0.0',
      pid: 99999, // foreign PID
      port: 3000,
      host: '127.0.0.1',
      startedAt: '2026-01-01'
    });
    expect(fs.existsSync(sm.path)).toBe(true);

    // Read valid state
    const state = sm.read();
    expect(state?.pid).toBe(99999);

    // Calling clean() when state PID is foreign does NOT remove file
    sm.clean();
    expect(fs.existsSync(sm.path)).toBe(true);

    // Overwrite with invalid schema (non-number port/pid)
    fs.writeFileSync(sm.path, JSON.stringify({ pid: 'not-a-number', name: 123 }));
    expect(sm.read()).toBeNull();

    // Calling clean() when state is invalid cleans it
    sm.clean();
    expect(fs.existsSync(sm.path)).toBe(false);

    // Calling forceClean on existing file deletes it
    sm.write({ name: 'to-force-clean', version: '1.0.0', pid: 1, port: 1, host: '127.0.0.1' });
    expect(fs.existsSync(sm.path)).toBe(true);
    sm.forceClean();
    expect(fs.existsSync(sm.path)).toBe(false);

    // Calling clean and forceClean on non-existent file is safe
    sm.clean();
    sm.forceClean();
    expect(fs.existsSync(sm.path)).toBe(false);
  });

  it('handles invalid JSON, non-object payloads, and bogus sessions at /mcp without crashing', async () => {
    const app = createMcpServer({
      name: 'malformed-payload-test',
      dataDir: testDir,
      port: 0,
      registerInCentral: false
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      // 1. Send invalid JSON syntax
      const parseErrRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"invalid": json'
      });
      expect(parseErrRes.status).toBe(400);
      const parseErrData = await parseErrRes.json();
      expect(parseErrData.error.code).toBe(-32700);

      // 2. Send non-object payload (primitive number)
      const nonObjRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '12345'
      });
      expect(nonObjRes.status).toBe(400);
      const nonObjData = await nonObjRes.json();
      expect(nonObjData.error.code).toBe(-32600);

      // 3. Send non-existent session ID
      const bogusSessionRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'mcp-session-id': 'non-existent-session-id'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      });
      expect(bogusSessionRes.status).toBe(404);
      const bogusSessionData = await bogusSessionRes.json();
      expect(bogusSessionData.error.code).toBe(-32001);

      // 4. Server is still fully healthy after all malformed attempts
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData.ok).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('auto-normalizes developer tool returns (raw strings and plain objects) into valid CallToolResult', async () => {
    const app = createMcpServer({
      name: 'auto-normalize-tool-test',
      dataDir: testDir,
      port: 0,
      registerInCentral: false
    });

    app.tool({
      name: 'raw_string_tool',
      description: 'Returns a raw string',
      handler: () => 'Hello from raw string!' as any
    });

    app.tool({
      name: 'plain_object_tool',
      description: 'Returns a plain object',
      handler: () => ({ score: 100, active: true }) as any
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    try {
      // Initialize MCP session
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' }
          }
        })
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const parseMcpResponse = (text: string) => {
        const match = text.match(/data:\s*(\{.*\})/);
        return match ? JSON.parse(match[1]) : JSON.parse(text);
      };

      // Call raw string tool
      const stringToolRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'raw_string_tool',
            arguments: {}
          }
        })
      });
      expect(stringToolRes.status).toBe(200);
      const stringToolData = parseMcpResponse(await stringToolRes.text());
      expect(stringToolData.result.content[0].type).toBe('text');
      expect(stringToolData.result.content[0].text).toBe('Hello from raw string!');

      // Call plain object tool
      const objectToolRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'plain_object_tool',
            arguments: {}
          }
        })
      });
      expect(objectToolRes.status).toBe(200);
      const objectToolData = parseMcpResponse(await objectToolRes.text());
      expect(objectToolData.result.content[0].type).toBe('text');
      expect(JSON.parse(objectToolData.result.content[0].text)).toEqual({ score: 100, active: true });
    } finally {
      await app.stop();
    }
  });

  it('stops cleanly and rapidly without hanging when active connections exist', async () => {
    const app = createMcpServer({
      name: 'rapid-shutdown-test',
      dataDir: testDir,
      port: 0,
      registerInCentral: false
    });

    const startResult = await app.start();
    const baseUrl = `http://${startResult.host}:${startResult.port}`;

    // Establish a session
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      })
    });
    expect(initRes.status).toBe(200);

    const stopStart = Date.now();
    await app.stop();
    const stopDuration = Date.now() - stopStart;

    // Shutdown must complete quickly (under 2 seconds)
    expect(stopDuration).toBeLessThan(2000);

    // Verify status is stopped
    const status = await app.status();
    expect(status.status).toBe('stopped');
  });
});
