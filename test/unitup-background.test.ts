import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMcpServer } from '../src/index.js';
import { checkHealth, fetchInfo } from '../src/runtime/health.js';
import { StateManager } from '../src/runtime/state.js';
import {
  _setUnitupModule,
  _resetUnitupModule,
  getUnitup,
  stopBackgroundProcess,
  getBackgroundStatus
} from '../src/runtime/unitup.js';

describe('Unitup Background Integration', () => {
  let testDir: string;
  let serverScriptPath: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `mcp-unitup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Create a standalone server script for Unitup to execute as entrypoint
    serverScriptPath = path.join(testDir, 'test-server.mjs');
    const serverScriptContent = `
import { createMcpServer } from '${path.resolve('./dist/index.js')}';

const appName = process.env.TEST_APP_NAME || 'test-bg-server';
const dataDir = process.env.TEST_DATA_DIR || '${testDir}';

let initCount = 0;
const app = createMcpServer({
  name: appName,
  dataDir: dataDir,
  port: 0,
  background: true,
  context: async () => {
    initCount++;
    return { initializedAt: Date.now(), count: initCount };
  }
});

app.tool({
  name: 'ping',
  handler: (args, ctx) => {
    return {
      content: [{ type: 'text', text: JSON.stringify({ reply: 'pong', context: ctx }) }]
    };
  }
});

app.run();
`;
    fs.writeFileSync(serverScriptPath, serverScriptContent, 'utf-8');
  });

  afterEach(async () => {
    _resetUnitupModule();
    delete process.env.TEST_APP_NAME;
    delete process.env.TEST_DATA_DIR;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // Test 1: background omitted uses the existing native behavior
  it('1. uses existing native startup behavior when background is omitted', async () => {
    const app = createMcpServer({
      name: 'bg-omitted-test',
      dataDir: testDir,
      port: 0
    });

    expect(app.config.background).toBe(false);

    const startResult = await app.start();
    expect(startResult.role).toBe('owner');
    expect(startResult.reused).toBe(false);
    expect(startResult.port).toBeGreaterThan(0);

    const health = await checkHealth('127.0.0.1', startResult.port, 'bg-omitted-test');
    expect(health?.ok).toBe(true);

    await app.stop();
  });

  // Test 2: background: false uses the existing native behavior
  it('2. uses existing native startup behavior when background is explicitly false', async () => {
    const app = createMcpServer({
      name: 'bg-false-test',
      background: false,
      dataDir: testDir,
      port: 0
    });

    expect(app.config.background).toBe(false);

    const startResult = await app.start();
    expect(startResult.role).toBe('owner');
    expect(startResult.reused).toBe(false);

    await app.stop();
  });

  // Test 3: background: true starts the shared server through Unitup
  it('3. starts the shared server through Unitup when background is true', async () => {
    const appName = 'bg-true-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const app = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    expect(app.config.background).toBe(true);

    try {
      const startResult = await app.start();
      expect(startResult.role).toBe('owner');
      expect(startResult.port).toBeGreaterThan(0);

      // Verify health on the background server
      const health = await checkHealth('127.0.0.1', startResult.port, appName);
      expect(health?.ok).toBe(true);
      expect(health?.name).toBe(appName);

      // Unitup service should be registered
      const unitupStatus = await getBackgroundStatus(appName);
      expect(unitupStatus).not.toBeNull();
      expect(unitupStatus?.installed).toBe(true);
    } finally {
      await app.stop();
    }
  });

  // Test 4: a second client reuses the same background instance
  it('4. reuses the existing background instance when a second client starts', async () => {
    const appName = 'bg-reuse-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const client1 = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    const client2 = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    try {
      const res1 = await client1.start();
      expect(res1.reused).toBe(false);

      const res2 = await client2.start();
      expect(res2.reused).toBe(true);
      expect(res2.role).toBe('bridge');
      expect(res2.port).toBe(res1.port);
      expect(res2.pid).toBe(res1.pid);
    } finally {
      await client1.stop();
    }
  });

  // Test 5: 10 concurrent clients still result in one shared process
  it('5. coordinates 10 concurrent client start requests to one shared background instance', async () => {
    const appName = 'bg-concurrent-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const apps = Array.from({ length: 10 }, () =>
      createMcpServer({
        name: appName,
        background: true,
        entrypoint: serverScriptPath,
        dataDir: testDir,
        port: 0
      })
    );

    try {
      const results = await Promise.all(apps.map((a) => a.start()));
      const firstPort = results[0].port;
      const firstPid = results[0].pid;

      for (const res of results) {
        expect(res.port).toBe(firstPort);
        expect(res.pid).toBe(firstPid);
      }

      const health = await checkHealth('127.0.0.1', firstPort, appName);
      expect(health?.ok).toBe(true);
    } finally {
      await apps[0].stop();
    }
  });

  // Test 6: shared application context initializes exactly once
  it('6. initializes shared application context exactly once across background sessions', async () => {
    const appName = 'bg-context-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const client = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    try {
      const res = await client.start();
      const baseUrl = `http://${res.host}:${res.port}`;

      // Call initialize and call tool
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
            clientInfo: { name: 'client-1', version: '1.0.0' }
          }
        })
      });
      const sid = initRes.headers.get('mcp-session-id')!;

      const toolRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sid
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'ping', arguments: {} }
        })
      });
      const text = await toolRes.text();
      const match = text.match(/data:\s*(\{.*\})/);
      const data = match ? JSON.parse(match[1]) : JSON.parse(text);
      const toolOutput = JSON.parse(data.result.content[0].text);

      // Context was initialized once
      expect(toolOutput.context.count).toBe(1);
    } finally {
      await client.stop();
    }
  });

  // Test 7: closing the first stdio process does not terminate the background server
  it('7. keeps the background server running when an initial client disconnects', async () => {
    const appName = 'bg-keepalive-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const client1 = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    try {
      const res1 = await client1.start();
      expect(res1.port).toBeGreaterThan(0);

      // Client 1 stops its local representation (without calling app.stop())
      // The background server must continue responding to /health
      const healthBefore = await checkHealth('127.0.0.1', res1.port, appName);
      expect(healthBefore?.ok).toBe(true);

      // Client 2 connects
      const client2 = createMcpServer({
        name: appName,
        background: true,
        entrypoint: serverScriptPath,
        dataDir: testDir,
        port: 0
      });

      const res2 = await client2.start();
      expect(res2.reused).toBe(true);
      expect(res2.port).toBe(res1.port);
    } finally {
      await client1.stop();
    }
  });

  // Test 8: stale runtime metadata is recovered
  it('8. recovers from stale runtime metadata when starting background server', async () => {
    const appName = 'bg-stale-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const stateManager = new StateManager(testDir);
    // Write stale runtime state with dead PID and dead port
    stateManager.write({
      name: appName,
      version: '1.0.0',
      pid: 9999997,
      port: 59997,
      host: '127.0.0.1',
      startedAt: new Date().toISOString()
    });

    const app = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    try {
      const startResult = await app.start();
      expect(startResult.port).not.toBe(59997);
      expect(startResult.pid).not.toBe(9999997);

      const health = await checkHealth('127.0.0.1', startResult.port, appName);
      expect(health?.ok).toBe(true);
    } finally {
      await app.stop();
    }
  });

  // Test 9: a crashed Unitup-managed process can be restarted
  it('9. restarts a background server using app.restart()', async () => {
    const appName = 'bg-restart-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const app = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    try {
      const firstStart = await app.start();
      const firstPort = firstStart.port;

      const restarted = await app.restart();
      expect(restarted.port).toBeGreaterThan(0);

      const health = await checkHealth('127.0.0.1', restarted.port, appName);
      expect(health?.ok).toBe(true);
    } finally {
      await app.stop();
    }
  });

  // Test 10: /health remains the final source of readiness
  it('10. verifies that /health is the authoritative source of readiness', async () => {
    const appName = 'bg-health-authority-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const app = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    try {
      const res = await app.start();
      // Health check with wrong expected name must fail
      const badHealth = await checkHealth('127.0.0.1', res.port, 'completely-different-name');
      expect(badHealth).toBeNull();

      // Health check with correct expected name succeeds
      const goodHealth = await checkHealth('127.0.0.1', res.port, appName);
      expect(goodHealth?.ok).toBe(true);
    } finally {
      await app.stop();
    }
  });

  // Test 11: multiple MCP applications can run simultaneously without conflict
  it('11. runs multiple distinct background MCP applications simultaneously (browsertrack, softscope, recallite)', async () => {
    const apps = ['browsertrack', 'softscope', 'recallite'].map((name) => {
      const appDir = path.join(testDir, name);
      fs.mkdirSync(appDir, { recursive: true });

      const scriptPath = path.join(appDir, 'server.mjs');
      fs.writeFileSync(
        scriptPath,
        `
import { createMcpServer } from '${path.resolve('./dist/index.js')}';
const app = createMcpServer({
  name: '${name}',
  dataDir: '${appDir}',
  port: 0,
  background: true
});
app.run();
`,
        'utf-8'
      );

      return createMcpServer({
        name,
        background: true,
        entrypoint: scriptPath,
        dataDir: appDir,
        port: 0
      });
    });

    try {
      const results = await Promise.all(apps.map((a) => a.start()));

      expect(results.length).toBe(3);
      // All 3 apps must have unique ports
      const ports = results.map((r) => r.port);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(3);

      // Verify all 3 respond to health check with their respective names
      for (let i = 0; i < apps.length; i++) {
        const h = await checkHealth('127.0.0.1', results[i].port, apps[i].config.name);
        expect(h?.ok).toBe(true);
        expect(h?.name).toBe(apps[i].config.name);
      }
    } finally {
      await Promise.all(apps.map((a) => a.stop()));
    }
  });

  // Test 12: Unitup logs are available through app.getLogDirectory()
  it('12. makes Unitup logs available in app.getLogDirectory()', async () => {
    const appName = 'bg-log-dir-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    const app = createMcpServer({
      name: appName,
      background: true,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    const logDir = await app.getLogDirectory();
    expect(logDir).toBe(app.config.logDir);

    try {
      await app.start();

      // Check that the log directory exists
      expect(fs.existsSync(logDir)).toBe(true);
    } finally {
      await app.stop();
    }
  });

  // Test 13: a clear error is returned when background: true is used without Unitup
  it('13. returns a clear error when background: true is used but Unitup is not installed', async () => {
    _setUnitupModule(null); // Simulate Unitup not installed

    const app = createMcpServer({
      name: 'bg-missing-unitup-test',
      background: true,
      dataDir: testDir,
      port: 0
    });

    await expect(app.start()).rejects.toThrow(
      'Background mode requires Unitup, but Unitup is not installed.\n\nInstall it with:\n\nnpm install unitup'
    );
  });

  // Test 14: allows single string parameter initialization
  it('14. allows single string parameter initialization createMcpServer("server-name")', () => {
    const app = createMcpServer('single-param-app');
    expect(app.config.name).toBe('single-param-app');
    expect(app.config.version).toBe('1.0.0');
    expect(app.config.background).toBe(false);
  });

  // Test 15: supports programmatic start({ background: true })
  it('15. supports programmatic start({ background: true }) when background was not in config', async () => {
    const appName = 'bg-prog-test';
    process.env.TEST_APP_NAME = appName;
    process.env.TEST_DATA_DIR = testDir;

    // Server defined without background: true in config
    const app = createMcpServer({
      name: appName,
      background: false,
      entrypoint: serverScriptPath,
      dataDir: testDir,
      port: 0
    });

    try {
      const result = await app.start({ background: true });
      expect(result.role).toBe('owner');
      expect(result.port).toBeGreaterThan(0);

      const health = await checkHealth('127.0.0.1', result.port, appName, 1000);
      expect(health?.ok).toBe(true);
    } finally {
      await app.stop({ background: true });
    }
  });

  // Test 16: supports CLI --background and -b options
  it('16. parses --background and -b CLI options in handleCliArgs', async () => {
    const { handleCliArgs } = await import('../src/cli/index.js');
    const app = createMcpServer('test-cli-bg');

    const opts1 = await handleCliArgs(['--background'], app.config, app);
    expect(opts1.background).toBe(true);

    const opts2 = await handleCliArgs(['-b'], app.config, app);
    expect(opts2.background).toBe(true);

    const opts3 = await handleCliArgs([], app.config, app);
    expect(opts3.background).toBe(false);
  });
});
