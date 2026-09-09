import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');
const binPath = path.resolve(distPath, 'cli/bin.js');

describe('End-to-End (E2E) Real Process CLI Workflows', () => {
  let tmpDir: string;
  let dataDir: string;
  let logDir: string;
  let registryPath: string;
  let serverJsPath: string;

  function runCli(args: string[], cwd = tmpDir, extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        MCPONCE_REGISTRY_PATH: registryPath,
        ...extraEnv
      },
      encoding: 'utf-8'
    });
  }

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mcponce-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dataDir = path.join(tmpDir, 'data');
    logDir = path.join(tmpDir, 'logs');
    registryPath = path.join(tmpDir, 'servers.json');

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    // Symlink node_modules so dependencies like zod are resolvable
    try {
      fs.symlinkSync(
        path.resolve(__dirname, '../node_modules'),
        path.join(tmpDir, 'node_modules'),
        'junction'
      );
    } catch {}

    // Package.json to mark directory as ESM
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-e2e-project', type: 'module' }, null, 2),
      'utf-8'
    );

    // Realistic user MCP server
    serverJsPath = path.join(tmpDir, 'server.js');
    const serverCode = `
import { McpServer, z } from '${path.join(distPath, 'index.js')}';

const app = new McpServer({
  name: 'e2e-demo-server',
  version: '1.2.3',
  port: 0,
  dataDir: ${JSON.stringify(dataDir)},
  logDir: ${JSON.stringify(logDir)},
  registerInCentral: true
});

app.tool('greet', { name: z.string().optional() }, async ({ name }) => {
  return \`Hello \${name || 'World'}!\`;
});

app.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => {
  return String(a + b);
});

app.tool('fail', {}, async () => {
  throw new Error('E2E simulated error');
});

app.tool('object_return', { key: z.string() }, async ({ key }) => {
  return { status: 'success', keyReceived: key };
});

await app.run();
`;
    fs.writeFileSync(serverJsPath, serverCode, 'utf-8');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Direct In-Process Server CLI (node server.js ...)', () => {
    it('executes tools directly without running in background', () => {
      const res = runCli([serverJsPath, 'call', 'greet', '--name', 'Ahmet']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Hello Ahmet!');
    });

    it('tolerates server name in call command (node server.js call e2e-demo-server greet)', () => {
      const res = runCli([serverJsPath, 'call', 'e2e-demo-server', 'greet', '--name', 'PairProgrammer']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Hello PairProgrammer!');
    });

    it('supports numeric input parsing and calculation', () => {
      const res = runCli([serverJsPath, 'call', 'add', '-a', '42', '-b', '58']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('100');
    });

    it('outputs valid JSON result with --json flag', () => {
      const res = runCli([serverJsPath, 'call', 'object_return', '--key', 'test-key', '--json']);
      expect(res.status).toBe(0);
      const json = JSON.parse(res.stdout.trim());
      expect(json.keyReceived || json.content?.[0]?.text).toBeTruthy();
      if (json.keyReceived) {
        expect(json.keyReceived).toBe('test-key');
      } else {
        expect(json.content[0].text).toContain('test-key');
      }
    });

    it('handles tool execution failures cleanly with non-zero exit code', () => {
      const res = runCli([serverJsPath, 'call', 'fail']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('E2E simulated error');
    });

    it('lists available tools with "tools" command', () => {
      const res = runCli([serverJsPath, 'tools']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Registered Tools (4):');
      expect(res.stdout).toContain('greet');
      expect(res.stdout).toContain('add');
      expect(res.stdout).toContain('fail');
      expect(res.stdout).toContain('object_return');
    });

    it('shows usage and available tools when "call" is invoked without tool name', () => {
      const res = runCli([serverJsPath, 'call']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Usage: call <tool-name>');
      expect(res.stdout).toContain('greet');
      expect(res.stdout).toContain('add');
    });

    it('shows info when "info" command is invoked', () => {
      const res = runCli([serverJsPath, 'info']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Name: e2e-demo-server');
      expect(res.stdout).toContain('Status: stopped');
    });
  });

  describe('2. Central CLI Local Script Delegation (mcponce call/tools <file>)', () => {
    it('delegates "call" with relative script file (mcponce call ./server.js greet)', () => {
      const res = runCli([binPath, 'call', './server.js', 'greet', '--name', 'DirectRelative']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Hello DirectRelative!');
    });

    it('delegates "call" with bare filename (mcponce call server.js greet)', () => {
      const res = runCli([binPath, 'call', 'server.js', 'greet', '--name', 'DirectBare']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Hello DirectBare!');
    });

    it('delegates "tools" with script file (mcponce tools server.js)', () => {
      const res = runCli([binPath, 'tools', 'server.js']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('greet');
      expect(res.stdout).toContain('add');
    });

    it('delegates "tools" with relative script file (mcponce tools ./server.js)', () => {
      const res = runCli([binPath, 'tools', './server.js']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('greet');
      expect(res.stdout).toContain('add');
    });

    it('auto-detects local server.js when user omits server name (mcponce call greet --name Auto)', () => {
      const res = runCli([binPath, 'call', 'greet', '--name', 'AutoDetected']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Hello AutoDetected!');
    });
  });

  describe('3. Central CLI Client Installer Flow', () => {
    it('installs cursor configuration extracting name from server.js', () => {
      const res = runCli([binPath, 'install', 'server.js', 'cursor', '--project']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Configured "e2e-demo-server" in MCP client(s)');
      expect(res.stdout).toContain('Next steps:');

      const configPath = path.join(tmpDir, '.cursor', 'mcp.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const conf = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(conf.mcpServers['e2e-demo-server']).toBeDefined();
      expect(conf.mcpServers['e2e-demo-server'].command).toBe('node');
    });

    it('uninstalls cursor configuration cleanly', () => {
      runCli([binPath, 'install', 'server.js', 'cursor', '--project']);
      const res = runCli([binPath, 'uninstall', 'e2e-demo-server', 'cursor', '--project']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Removed "e2e-demo-server" from cursor');

      const configPath = path.join(tmpDir, '.cursor', 'mcp.json');
      const conf = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(conf.mcpServers['e2e-demo-server']).toBeUndefined();
    });
  });

  describe('4. Central CLI Daemon & Real Remote HTTP/SSE Invocations', () => {
    let serverProcess: ChildProcess | undefined;

    afterEach(async () => {
      if (serverProcess && !serverProcess.killed) {
        try {
          serverProcess.kill('SIGKILL');
        } catch {}
      }
    });

    it('connects to running daemon over HTTP/SSE, lists tools and executes calls', async () => {
      // Launch server in background worker mode (running native HTTP server)
      serverProcess = spawn(process.execPath, [serverJsPath], {
        cwd: tmpDir,
        env: {
          ...process.env,
          MCPONCE_REGISTRY_PATH: registryPath,
          MCPONCE_BACKGROUND_SERVER: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Wait for server to register in central registry
      let serverInfo: any = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (fs.existsSync(registryPath)) {
          try {
            const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
            if (reg.servers && reg.servers['e2e-demo-server']?.status === 'running' && reg.servers['e2e-demo-server']?.port) {
              serverInfo = reg.servers['e2e-demo-server'];
              break;
            }
          } catch {}
        }
      }

      expect(serverInfo).not.toBeNull();
      expect(serverInfo.port).toBeGreaterThan(0);

      // Verify "mcponce list" shows the running server
      const listRes = runCli([binPath, 'list']);
      expect(listRes.status).toBe(0);
      expect(listRes.stdout).toContain('e2e-demo-server');
      expect(listRes.stdout).toContain('running');

      // Verify "mcponce status e2e-demo-server" shows details
      const statusRes = runCli([binPath, 'status', 'e2e-demo-server']);
      expect(statusRes.status).toBe(0);
      expect(statusRes.stdout).toContain('Name: e2e-demo-server');
      expect(statusRes.stdout).toContain('Status: running');

      // Verify "mcponce tools e2e-demo-server" queries real HTTP endpoint, parses SSE response
      const toolsRes = runCli([binPath, 'tools', 'e2e-demo-server']);
      expect(toolsRes.status).toBe(0);
      expect(toolsRes.stdout).toContain('Tools available on server "e2e-demo-server" (4):');
      expect(toolsRes.stdout).toContain('greet');
      expect(toolsRes.stdout).toContain('add');

      // Verify "mcponce call e2e-demo-server greet --name RemoteTester" over HTTP SSE stream
      const callRes = runCli([binPath, 'call', 'e2e-demo-server', 'greet', '--name', 'RemoteTester']);
      expect(callRes.status).toBe(0);
      expect(callRes.stdout).toContain('Hello RemoteTester!');

      // Verify "mcponce call e2e-demo-server add -a 25 -b 75"
      const addRes = runCli([binPath, 'call', 'e2e-demo-server', 'add', '-a', '25', '-b', '75']);
      expect(addRes.status).toBe(0);
      expect(addRes.stdout).toContain('100');

      // Verify JSON output over remote HTTP
      const jsonRes = runCli([binPath, 'call', 'e2e-demo-server', 'greet', '--name', 'JsonTester', '--json']);
      expect(jsonRes.status).toBe(0);
      const parsedJson = JSON.parse(jsonRes.stdout.trim());
      expect(parsedJson.content[0].text).toContain('Hello JsonTester!');

      // Verify tool error handling over remote HTTP
      const failRes = runCli([binPath, 'call', 'e2e-demo-server', 'fail']);
      expect(failRes.status).toBe(1);
      expect(failRes.stderr).toContain('E2E simulated error');

      // Verify Web Inspector serving EUIX + Tailwind single HTML at GET /inspect
      const inspectRes = await fetch(`http://127.0.0.1:${serverInfo.port}/inspect`);
      expect(inspectRes.status).toBe(200);
      expect(inspectRes.headers.get('content-type')).toContain('text/html');
      const inspectHtml = await inspectRes.text();
      expect(inspectHtml).toContain('https://cdn.tailwindcss.com');
      expect(inspectHtml).toContain('https://unpkg.com/euixjs/dist/EUIXEngine.umd.js');
      expect(inspectHtml).toContain('<uid_spec>');
      expect(inspectHtml).toContain('</uid_spec>');
      expect(inspectHtml).toContain('<data_model>');
      expect(inspectHtml).toContain('e2e-demo-server');

      // Verify Inspector API state endpoint returns real background server state
      const stateRes = await fetch(`http://127.0.0.1:${serverInfo.port}/inspect/api/state`);
      expect(stateRes.status).toBe(200);
      const stateData = await stateRes.json();
      expect(stateData.server.name).toBe('e2e-demo-server');
      expect(stateData.tools.length).toBe(4);
      expect(stateData.tools.some((t: any) => t.name === 'add')).toBe(true);

      // Verify Inspector Tool Execution endpoint executes tool on real background server
      const execRes = await fetch(`http://127.0.0.1:${serverInfo.port}/inspect/api/tools/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: { a: 40, b: 60 } })
      });
      expect(execRes.status).toBe(200);
      const execData = await execRes.json();
      expect(execData.success).toBe(true);
      expect(execData.result.content[0].text).toBe('100');
      expect(typeof execData.durationMs).toBe('number');

      // Verify "mcponce analytics e2e-demo-server" returns accurate analytics from real background server
      const analyticsRes = runCli([binPath, 'analytics', 'e2e-demo-server']);
      expect(analyticsRes.status).toBe(0);
      expect(analyticsRes.stdout).toContain('mcponce Analytics: e2e-demo-server');
      expect(analyticsRes.stdout).toContain('Total Invocations:');
      expect(analyticsRes.stdout).toContain('Tool Performance:');
      expect(analyticsRes.stdout).toContain('greet');
      expect(analyticsRes.stdout).toContain('add');
      expect(analyticsRes.stdout).toContain('fail');

      // Verify "mcponce analytics e2e-demo-server --json" returns valid JSON analytics
      const analyticsJsonRes = runCli([binPath, 'analytics', 'e2e-demo-server', '--json']);
      expect(analyticsJsonRes.status).toBe(0);
      const analyticsJson = JSON.parse(analyticsJsonRes.stdout.trim());
      expect(analyticsJson.summary.totalInvocations).toBeGreaterThanOrEqual(5);
      expect(analyticsJson.tools['greet'].calls).toBe(2);
      expect(analyticsJson.tools['add'].calls).toBeGreaterThanOrEqual(1);
      expect(analyticsJson.tools['fail'].calls).toBe(1);
      expect(analyticsJson.tools['fail'].errors).toBe(1);

      // Verify local script analytics "node server.js analytics" also gets the accurate metrics
      const localAnalyticsRes = runCli([serverJsPath, 'analytics']);
      expect(localAnalyticsRes.status).toBe(0);
      expect(localAnalyticsRes.stdout).toContain('mcponce Analytics: e2e-demo-server');
      expect(localAnalyticsRes.stdout).toContain('Total Invocations:');
      expect(localAnalyticsRes.stdout).toContain('greet');

      // Stop server via CLI
      const stopRes = runCli([binPath, 'stop', 'e2e-demo-server']);
      expect(stopRes.status).toBe(0);
      expect(stopRes.stdout).toContain('done');
    });
  });

  describe('5. Error UX and Actionable Developer Diagnostics', () => {
    it('provides helpful hints with local script when server is not found in registry', () => {
      const res = runCli([binPath, 'call', 'my-mcp', 'hello']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Error: Server "my-mcp" not found in registry.');
      expect(res.stderr).toContain('Found local server script: ./server.js');
      expect(res.stderr).toContain('node server.js call hello');
      expect(res.stderr).toContain('node server.js start');
    });

    it('provides helpful hints when tools is called for an unregistered server', () => {
      const res = runCli([binPath, 'tools', 'my-mcp']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Error: Server "my-mcp" not found in registry.');
      expect(res.stderr).toContain('Found local server script: ./server.js');
      expect(res.stderr).toContain('node server.js tools');
      expect(res.stderr).toContain('node server.js start');
    });

    it('provides helpful hints when analytics is called for an unregistered server', () => {
      const res = runCli([binPath, 'analytics', 'my-mcp']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Error: Server "my-mcp" not found in registry.');
      expect(res.stderr).toContain('Found local server script: ./server.js');
      expect(res.stderr).toContain('node server.js analytics');
      expect(res.stderr).toContain('node server.js start');
    });

    it('reports server not running when registered but stopped', () => {
      // Register a stopped server in the registry
      fs.writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          servers: {
            'stopped-srv': {
              name: 'stopped-srv',
              version: '1.0.0',
              status: 'stopped',
              dataDir,
              logDir
            }
          }
        }),
        'utf-8'
      );

      const res = runCli([binPath, 'call', 'stopped-srv', 'greet']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Error: Server "stopped-srv" is not running.');
      expect(res.stderr).toContain('Start the server before calling its tools.');
    });
  });
});
