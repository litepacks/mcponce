#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CentralRegistry } from '../registry/central.js';
import { fetchInfo } from '../runtime/health.js';
import { parseParametricArgs } from './tool-caller.js';
import { installClientConfig, uninstallClientConfig } from './installer.js';

export let registry = new CentralRegistry();
export function setRegistry(newReg: CentralRegistry) {
  registry = newReg;
}

export function formatStatus(status: 'running' | 'stopped'): string {
  if (status === 'running') {
    return '\x1b[32m● running\x1b[0m';
  }
  return '\x1b[90m○ stopped\x1b[0m';
}

export function pad(str: string | number, width: number): string {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

export async function listServers() {
  const servers = await registry.getAll(true);

  console.log(`\x1b[1mmcponce servers\x1b[0m (registry: ${registry.path})\n`);

  if (servers.length === 0) {
    console.log('No MCP servers registered yet.');
    console.log('Servers created with createMcpServer() register here automatically when started.\n');
    return;
  }

  // Table header
  console.log(
    `${pad('NAME', 20)} ${pad('STATUS', 15)} ${pad('PID', 8)} ${pad('PORT', 8)} ${pad('HOST', 12)} DATA DIRECTORY`
  );
  console.log('-'.repeat(80));

  for (const s of servers) {
    const statusText = formatStatus(s.status);
    const pidStr = s.pid ? String(s.pid) : '-';
    const portStr = s.port ? String(s.port) : '-';
    const hostStr = s.host || '-';

    console.log(
      `${pad(s.name, 20)} ${pad(statusText, 24)} ${pad(pidStr, 8)} ${pad(portStr, 8)} ${pad(hostStr, 12)} ${s.dataDir}`
    );
  }
  console.log('');
}

export async function showStatus(name?: string) {
  if (!name) {
    await listServers();
    return;
  }

  const server = await registry.get(name);
  if (!server) {
    console.error(`Server "${name}" not found in registry.`);
    process.exit(1);
  }

  console.log(`Name: ${server.name}`);
  console.log(`Version: ${server.version}`);
  console.log(`Status: ${server.status}`);
  console.log(`Data directory: ${server.dataDir}`);
  console.log(`Log directory: ${server.logDir}`);

  if (server.status === 'running' && server.port && server.host) {
    console.log(`PID: ${server.pid}`);
    console.log(`Host: ${server.host}`);
    console.log(`Port: ${server.port}`);
    console.log(`Started: ${server.startedAt || 'unknown'}`);

    const info = await fetchInfo(server.host, server.port, 1000);
    if (info) {
      console.log(`Active sessions: ${info.activeSessions}`);
      console.log(`Total sessions: ${info.totalSessions}`);
      if (info.lastClientConnection) {
        console.log(`Last connection: ${info.lastClientConnection}`);
      }
      if (info.lastToolInvocation) {
        console.log(
          `Last tool invocation: ${info.lastToolInvocation.name} at ${info.lastToolInvocation.timestamp}`
        );
      }
    }
  }
}

export async function stopServer(target?: string) {
  if (!target) {
    console.error('Usage: mcponce stop <server-name | --all>');
    process.exit(1);
  }

  if (target === '--all') {
    const servers = await registry.getAll(true);
    const running = servers.filter((s) => s.status === 'running');
    if (running.length === 0) {
      console.log('No running servers found.');
      return;
    }

    for (const s of running) {
      process.stdout.write(`Stopping "${s.name}" (PID ${s.pid})... `);
      const stopped = await registry.stop(s.name);
      if (stopped) {
        console.log('\x1b[32mdone\x1b[0m');
      } else {
        console.log('\x1b[31mfailed\x1b[0m');
      }
    }
    return;
  }

  const server = await registry.get(target);
  if (!server) {
    console.error(`Server "${target}" is not registered.`);
    process.exit(1);
  }

  if (server.status !== 'running') {
    console.log(`Server "${target}" is already stopped.`);
    return;
  }

  process.stdout.write(`Stopping "${target}" (PID ${server.pid})... `);
  const ok = await registry.stop(target);
  if (ok) {
    console.log('\x1b[32mdone\x1b[0m');
  } else {
    console.log('\x1b[31mfailed to stop\x1b[0m');
  }
}

export async function showLogs(name?: string, limitStr = '50') {
  if (!name) {
    console.error('Usage: mcponce logs <server-name> [lines]');
    process.exit(1);
  }

  const server = await registry.get(name);
  if (!server) {
    console.error(`Server "${name}" is not registered.`);
    process.exit(1);
  }

  const currentLog = path.join(server.logDir, 'current.log');
  console.log(`Log file: ${currentLog}`);

  if (!fs.existsSync(currentLog)) {
    console.log('No logs found for this server.');
    return;
  }

  const limit = parseInt(limitStr, 10) || 50;
  const content = fs.readFileSync(currentLog, 'utf-8');
  const lines = content.trim().split('\n').filter((l) => l.length > 0);
  const recent = lines.slice(-limit);

  console.log(`--- Recent ${recent.length} lines ---`);
  for (const line of recent) {
    console.log(line);
  }
}

export async function cleanRegistry() {
  const removed = await registry.clean();
  console.log(`Removed ${removed} stopped server(s) from registry.`);
}

export function findLocalServerScript(): string | null {
  const candidates = [
    'index.js',
    'server.js',
    'main.js',
    'app.js',
    'index.mjs',
    'server.mjs',
    'index.ts',
    'server.ts'
  ];
  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return c;
    }
  }
  return null;
}

export function extractServerNameFromEntrypoint(entrypointPath: string): string | null {
  try {
    if (fs.existsSync(entrypointPath) && fs.statSync(entrypointPath).isFile()) {
      const content = fs.readFileSync(entrypointPath, 'utf-8');
      const match = content.match(/name\s*:\s*['"`]([^'"`]+)['"`]/);
      if (match && match[1]) {
        return match[1];
      }
    }
    const dir = fs.statSync(entrypointPath).isDirectory() ? entrypointPath : path.dirname(entrypointPath);
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) {
        return pkg.name;
      }
    }
  } catch {}
  return null;
}

export async function delegateToScript(
  targetFile: string,
  action: string,
  toolName?: string,
  rawArgs: string[] = []
): Promise<void> {
  const isTs = targetFile.endsWith('.ts');
  const runner = isTs ? 'npx' : 'node';
  const runnerArgs = isTs
    ? ['tsx', targetFile, action, ...(toolName ? [toolName] : []), ...rawArgs]
    : [targetFile, action, ...(toolName ? [toolName] : []), ...rawArgs];
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(runner, runnerArgs, { stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

export async function parseMcpResponse(res: any): Promise<any> {
  const contentType = (typeof res.headers?.get === 'function' ? res.headers.get('content-type') : '') || '';
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6).trim();
        if (jsonStr) {
          try {
            return JSON.parse(jsonStr);
          } catch {}
        }
      }
    }
    return JSON.parse(text);
  }
  try {
    return await res.json();
  } catch {
    const text = await res.text();
    const dataLine = text.split('\n').find((l: string) => l.startsWith('data: '));
    if (dataLine) {
      return JSON.parse(dataLine.slice(6).trim());
    }
    return JSON.parse(text);
  }
}

export async function callServerTool(serverName?: string, toolName?: string, rawArgs: string[] = []) {
  if (!serverName || serverName === '--help' || serverName === '-h') {
    console.log('Usage: mcponce call <server> <tool> [params...] [--json]');
    console.log('Example: mcponce call hello-mcp calculate --operation add -a 10 -b 20\n');
    process.exit(1);
  }

  // If user typed: mcponce call <tool> [params...] (omitting server name when in a directory with a local server script)
  if (!toolName || toolName.startsWith('-')) {
    const reg = await registry.get(serverName);
    if (!reg) {
      const localScript = findLocalServerScript();
      if (localScript && serverName !== localScript) {
        const actualTool = serverName;
        const actualRawArgs = toolName ? [toolName, ...rawArgs] : rawArgs;
        return await delegateToScript(path.resolve(process.cwd(), localScript), 'call', actualTool, actualRawArgs);
      }
    }
    console.log('Usage: mcponce call <server> <tool> [params...] [--json]');
    console.log('Example: mcponce call hello-mcp calculate --operation add -a 10 -b 20\n');
    process.exit(1);
  }

  // If target is a script file (e.g. mcponce call ./index.js hello or mcponce call index.js hello)
  const candidatePath = path.resolve(process.cwd(), serverName);
  if (fs.existsSync(serverName) || fs.existsSync(candidatePath)) {
    const targetFile = fs.existsSync(serverName) ? path.resolve(serverName) : candidatePath;
    if (fs.statSync(targetFile).isFile()) {
      return await delegateToScript(targetFile, 'call', toolName, rawArgs);
    }
  }

  const server = await registry.get(serverName);
  if (!server) {
    console.error(`Error: Server "${serverName}" not found in registry.`);
    const localScript = findLocalServerScript();
    if (localScript) {
      const relScript = localScript.startsWith('.') ? localScript : `./${localScript}`;
      console.error(`\nFound local server script: ${relScript}`);
      console.error(`  Run directly: node ${localScript} call ${toolName} ${rawArgs.join(' ')}`);
      console.error(`  Or with CLI:  mcponce call ${relScript} ${toolName} ${rawArgs.join(' ')}`);
      console.error(`  To start daemon: node ${localScript} start\n`);
    } else {
      const all = await registry.getAll(false);
      if (all.length > 0) {
        console.error(`Available registered servers: ${all.map((s) => s.name).join(', ')}`);
      }
      console.error(`Tip: Start the server with: node <script> start\n`);
    }
    process.exit(1);
  }

  if (server.status !== 'running' || !server.port || !server.host) {
    console.error(`Error: Server "${serverName}" is not running.`);
    console.error(`Start the server before calling its tools.\n`);
    process.exit(1);
  }

  const parsed = parseParametricArgs(rawArgs);
  const token = parsed.token || process.env.MCP_TOKEN || process.env.MCP_API_KEY;

  try {
    const url = `http://${server.host}:${server.port}/mcp`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-API-Key'] = token;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: parsed.params
        }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`HTTP Error ${res.status}: ${text}`);
      process.exit(1);
    }

    const data: any = await parseMcpResponse(res);
    if (data.error) {
      console.error(`\x1b[31mError [${data.error.code}]:\x1b[0m ${data.error.message}`);
      process.exit(1);
    }

    const result = data.result;
    if (result?.isError) {
      if (parsed.isJsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const msg = result.content?.[0]?.text || result.text || 'Tool execution failed';
        console.error(`\x1b[31mTool Error [${toolName}]:\x1b[0m ${msg}`);
      }
      process.exit(1);
    }

    if (parsed.isJsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const text = result?.content?.[0]?.text || result?.text;
      if (text) {
        console.log(text);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (err: any) {
    console.error(`Failed to invoke tool on server "${serverName}":`, err.message || err);
    process.exit(1);
  }
}

export async function listServerTools(serverName?: string, rawArgs: string[] = []) {
  if (!serverName || serverName === '--help' || serverName === '-h') {
    const localScript = findLocalServerScript();
    if (localScript) {
      return await delegateToScript(path.resolve(process.cwd(), localScript), 'tools');
    }
    console.log('Usage: mcponce tools <server> [--token <token>]');
    process.exit(1);
  }

  // If target is a script file (e.g. mcponce tools ./index.js or mcponce tools index.js)
  const candidatePath = path.resolve(process.cwd(), serverName);
  if (fs.existsSync(serverName) || fs.existsSync(candidatePath)) {
    const targetFile = fs.existsSync(serverName) ? path.resolve(serverName) : candidatePath;
    if (fs.statSync(targetFile).isFile()) {
      return await delegateToScript(targetFile, 'tools');
    }
  }

  const server = await registry.get(serverName);
  if (!server) {
    console.error(`Error: Server "${serverName}" not found in registry.`);
    const localScript = findLocalServerScript();
    if (localScript) {
      const relScript = localScript.startsWith('.') ? localScript : `./${localScript}`;
      console.error(`\nFound local server script: ${relScript}`);
      console.error(`  Run directly: node ${localScript} tools`);
      console.error(`  Or with CLI:  mcponce tools ${relScript}`);
      console.error(`  To start daemon: node ${localScript} start\n`);
    } else {
      const all = await registry.getAll(false);
      if (all.length > 0) {
        console.error(`Available registered servers: ${all.map((s) => s.name).join(', ')}`);
      }
      console.error(`Tip: Start the server with: node <script> start\n`);
    }
    process.exit(1);
  }

  if (server.status !== 'running' || !server.port || !server.host) {
    console.error(`Error: Server "${serverName}" is not running.`);
    process.exit(1);
  }

  const parsed = parseParametricArgs(rawArgs);
  const token = parsed.token || process.env.MCP_TOKEN || process.env.MCP_API_KEY;

  try {
    const url = `http://${server.host}:${server.port}/mcp`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-API-Key'] = token;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/list',
        params: {}
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`HTTP Error ${res.status}: ${text}`);
      process.exit(1);
    }

    const data: any = await parseMcpResponse(res);
    if (data.error) {
      console.error(`Error: ${data.error.message}`);
      process.exit(1);
    }

    const tools = data.result?.tools || [];
    console.log(`\n\x1b[1mTools available on server "${serverName}" (${tools.length}):\x1b[0m\n`);

    if (tools.length === 0) {
      console.log('  No tools registered on this server.\n');
      return;
    }

    for (const t of tools) {
      console.log(`  \x1b[1m\x1b[36m${t.name}\x1b[0m`);
      if (t.description) {
        console.log(`    ${t.description}`);
      }
      const properties = t.inputSchema?.properties || {};
      const propKeys = Object.keys(properties);
      if (propKeys.length > 0) {
        const sig = propKeys.map((k: string) => `--${k} <${properties[k].type || 'any'}>`).join(' ');
        console.log(`    \x1b[90mUsage: mcponce call ${serverName} ${t.name} ${sig}\x1b[0m`);
      } else {
        console.log(`    \x1b[90mUsage: mcponce call ${serverName} ${t.name}\x1b[0m`);
      }
      console.log('');
    }
  } catch (err: any) {
    console.error(`Failed to list tools from server "${serverName}":`, err.message || err);
    process.exit(1);
  }
}

export async function installServer(target?: string, clientArg = 'all', flags: string[] = []) {
  if (!target) {
    console.error('Usage: mcponce install <path-to-script | registered-server-name> [client] [--dry-run] [--project]');
    process.exit(1);
  }

  let serverName = target;
  let entrypoint = target;

  if (fs.existsSync(target)) {
    entrypoint = path.resolve(target);
    const extracted = extractServerNameFromEntrypoint(entrypoint);
    if (extracted) {
      serverName = extracted;
    } else {
      const base = path.basename(target, path.extname(target));
      serverName =
        base === 'index' || base === 'server' || base === 'main'
          ? path.basename(path.dirname(entrypoint))
          : base;
    }
  } else {
    const regServer = await registry.get(target);
    if (regServer) {
      serverName = regServer.name;
      entrypoint = (regServer as any).entrypoint || (regServer as any).scriptPath || target;
    }
  }

  const dryRun = flags.includes('--dry-run');
  const project = flags.includes('--project');
  const background = !flags.includes('--no-background');

  try {
    const results = installClientConfig({
      serverName,
      entrypoint,
      client: clientArg,
      background,
      project,
      dryRun
    });

    console.log(
      `\n\x1b[1m\x1b[32m✔\x1b[0m ${dryRun ? '[Dry-run] Would configure' : 'Configured'} "${serverName}" in MCP client(s):\n`
    );
    for (const r of results) {
      console.log(`  \x1b[1m${r.client}\x1b[0m: ${r.configPath}`);
      console.log(`    Command: ${r.serverEntry.command} ${r.serverEntry.args.join(' ')}\n`);
    }

    const rel = path.relative(process.cwd(), entrypoint);
    const scriptDisplay = rel.startsWith('.') ? rel : `./${rel}`;
    console.log(`\x1b[1mNext steps:\x1b[0m`);
    console.log(`  • Test tools directly: node ${scriptDisplay} call <tool>`);
    console.log(`  • List available tools: node ${scriptDisplay} tools`);
    console.log(`  • Start background daemon: node ${scriptDisplay} start\n`);
  } catch (err: any) {
    console.error(`Failed to install client config:`, err.message || err);
    process.exit(1);
  }
}

export async function uninstallServer(target?: string, clientArg = 'all', flags: string[] = []) {
  if (!target) {
    console.error('Usage: mcponce uninstall <server-name> [client] [--dry-run] [--project]');
    process.exit(1);
  }

  const dryRun = flags.includes('--dry-run');
  const project = flags.includes('--project');

  try {
    const results = uninstallClientConfig({
      serverName: target,
      client: clientArg,
      project,
      dryRun
    });

    for (const r of results) {
      if (r.removed) {
        console.log(`\x1b[32m✔\x1b[0m Removed "${target}" from ${r.client} (${r.configPath})`);
      } else {
        console.log(`\x1b[90m○\x1b[0m "${target}" was not found in ${r.client} (${r.configPath})`);
      }
    }
  } catch (err: any) {
    console.error(`Failed to uninstall client config:`, err.message || err);
    process.exit(1);
  }
}

export async function inspectServer(name?: string) {
  let target = name;
  if (!target) {
    const servers = await registry.getAll(true);
    const running = servers.filter((s) => s.status === 'running');
    if (running.length === 0) {
      console.error('No running MCP servers found in central registry.');
      console.error('Start a server first, or run inspect on a script: node server.js inspect');
      process.exit(1);
    }
    target = running[0].name;
  }

  const server = await registry.get(target);
  if (!server || server.status !== 'running' || !server.port) {
    console.error(`Server "${target}" is not running.`);
    process.exit(1);
  }

  const host = server.host || 'localhost';
  const url = `http://${host}:${server.port}/inspect`;
  console.log(`\n\x1b[1m\x1b[32m✔\x1b[0m Opening Web Inspector for "${target}" at: \x1b[4m\x1b[36m${url}\x1b[0m\n`);
  const { openBrowser } = await import('../utils/browser.js');
  await openBrowser(url);
}

export async function runOpenApiServer(specPathOrUrl: string, flags: string[]) {
  if (!specPathOrUrl) {
    console.error('Usage: mcponce openapi <url-or-file> [--port 3000] [--prefix prefix] [--name name] [--no-inspect]');
    process.exit(1);
  }

  const portIdx = flags.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(flags[portIdx + 1], 10) : 3000;

  const prefixIdx = flags.indexOf('--prefix');
  const prefix = prefixIdx !== -1 ? flags[prefixIdx + 1] : undefined;

  const nameIdx = flags.indexOf('--name');
  const name = nameIdx !== -1 ? flags[nameIdx + 1] : 'openapi-mcp';

  console.log(`\x1b[1mLoading OpenAPI specification:\x1b[0m ${specPathOrUrl}`);
  const { createMcpServer } = await import('../index.js');
  const app = createMcpServer({
    name,
    port: isNaN(port) ? 3000 : port
  });

  const count = await app.fromOpenApi(specPathOrUrl, { prefix });
  console.log(`\x1b[32m✔\x1b[0m Loaded and registered \x1b[1m${count}\x1b[0m tools from OpenAPI specification.`);

  const res = await app.start({ background: false });
  const url = app.getInspectorUrl(res.host);
  console.log(`\n\x1b[1m\x1b[32m✔\x1b[0m MCP server "${name}" running on http://${res.host}:${res.port}`);
  console.log(`\x1b[1m\x1b[36m✔\x1b[0m Web Inspector available at: \x1b[4m\x1b[36m${url}\x1b[0m\n`);

  if (!flags.includes('--no-inspect')) {
    const { openBrowser } = await import('../utils/browser.js');
    await openBrowser(url);
  }
}

export async function showAnalytics(target?: string, rawArgs: string[] = []) {
  const allFlags = [...(target && target.startsWith('-') ? [target] : []), ...rawArgs];
  const asJson = allFlags.includes('--json');
  let serverName = target && !target.startsWith('-') ? target : undefined;

  if (serverName === '--help' || serverName === '-h' || allFlags.includes('--help') || allFlags.includes('-h')) {
    console.log('Usage: mcponce analytics [server] [--json]');
    console.log('Example: mcponce analytics my-mcp');
    console.log('         mcponce analytics my-mcp --json\n');
    process.exit(0);
  }

  // If serverName is a file (e.g. mcponce analytics index.js)
  if (serverName) {
    const candidatePath = path.resolve(process.cwd(), serverName);
    if (fs.existsSync(serverName) || fs.existsSync(candidatePath)) {
      const targetFile = fs.existsSync(serverName) ? path.resolve(serverName) : candidatePath;
      if (fs.statSync(targetFile).isFile()) {
        return await delegateToScript(targetFile, 'analytics', undefined, rawArgs.filter((a) => a !== serverName));
      }
    }
  }

  // If serverName not specified, try to find running server from registry
  if (!serverName) {
    const servers = await registry.getAll(true);
    const running = servers.filter((s) => s.status === 'running');
    if (running.length === 1) {
      serverName = running[0].name;
    } else if (running.length > 1) {
      console.error(`Multiple servers are currently running: ${running.map((s) => s.name).join(', ')}`);
      console.error(`Please specify which server to inspect: mcponce analytics <server-name>\n`);
      process.exit(1);
    } else {
      // 0 running servers in central registry, check for local server script
      const localScript = findLocalServerScript();
      if (localScript) {
        return await delegateToScript(path.resolve(process.cwd(), localScript), 'analytics', undefined, rawArgs);
      }
      console.error('No running MCP servers found in central registry.');
      console.error('Start a server first, or run analytics on a script: node server.js analytics\n');
      process.exit(1);
    }
  }

  const server = await registry.get(serverName);
  if (!server) {
    console.error(`Error: Server "${serverName}" not found in registry.`);
    const localScript = findLocalServerScript();
    if (localScript) {
      const relScript = localScript.startsWith('.') ? localScript : `./${localScript}`;
      console.error(`\nFound local server script: ${relScript}`);
      console.error(`  Run directly: node ${localScript} analytics`);
      console.error(`  To start daemon: node ${localScript} start\n`);
    } else {
      const all = await registry.getAll(false);
      if (all.length > 0) {
        console.error(`Available registered servers: ${all.map((s) => s.name).join(', ')}`);
      }
      console.error(`Tip: Start the server with: node <script> start\n`);
    }
    process.exit(1);
  }

  if (server.status !== 'running' || !server.port || !server.host) {
    console.error(`Error: Server "${serverName}" is not running.`);
    console.error(`Start the server before fetching analytics.\n`);
    process.exit(1);
  }

  const { fetchAnalytics, renderAnalyticsOutput } = await import('./analytics.js');
  const analytics = await fetchAnalytics(server.host, server.port, 3000);

  if (!analytics) {
    if (asJson) {
      console.log(JSON.stringify({ error: `Failed to retrieve analytics from http://${server.host}:${server.port}/analytics` }));
    } else {
      console.error(`Failed to retrieve analytics from http://${server.host}:${server.port}/analytics`);
    }
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(analytics, null, 2));
    return;
  }

  renderAnalyticsOutput(server.name, server.pid, server.host, server.port, analytics);
}

export function printHelp() {
  console.log(`\x1b[1mmcponce\x1b[0m - Central management CLI for local MCP servers\n`);
  console.log('Usage:');
  console.log('  mcponce <command> [options]\n');
  console.log('Commands:');
  console.log('  list, ls                         List all registered MCP servers and their statuses');
  console.log('  status [name]                    Show status and runtime metrics for a server (or all)');
  console.log('  inspect [name]                   Open interactive Web Inspector for running server');
  console.log('  openapi <url-or-file> [options]  Run instant MCP server from OpenAPI/Swagger spec');
  console.log('  install <target> [client]        Install server into Claude Desktop or Cursor configs');
  console.log('  uninstall <server> [client]      Remove server from Claude Desktop or Cursor configs');
  console.log('  call <server> <tool> [params...] Execute a tool on a running server with parameters');
  console.log('  tools <server>                   List available tools and schemas on a running server');
  console.log('  analytics [server] [--json]      Show execution metrics and call graph for a server');
  console.log('  stop <name | --all>              Stop a running server instance');
  console.log('  logs <name> [lines]              View recent logs of a specific server');
  console.log('  clean                            Remove stopped/inactive servers from registry');
  console.log('  help, --help, -h                 Show this help message');
  console.log('  version, --version, -v           Show mcponce version\n');
}

export async function main(customArgs?: string[]) {
  const args = customArgs ?? process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  switch (cmd) {
    case undefined:
    case 'list':
    case 'ls':
      await listServers();
      break;
    case 'status':
      await showStatus(args[1]);
      break;
    case 'install':
      await installServer(
        args[1],
        args[2] && !args[2].startsWith('--') ? args[2] : 'all',
        args.slice(args[2] && !args[2].startsWith('--') ? 3 : 2)
      );
      break;
    case 'uninstall':
      await uninstallServer(
        args[1],
        args[2] && !args[2].startsWith('--') ? args[2] : 'all',
        args.slice(args[2] && !args[2].startsWith('--') ? 3 : 2)
      );
      break;
    case 'call':
      await callServerTool(args[1], args[2], args.slice(3));
      break;
    case 'tools':
      await listServerTools(args[1], args.slice(2));
      break;
    case 'analytics':
      await showAnalytics(args[1], args.slice(2));
      break;
    case 'stop':
      await stopServer(args[1]);
      break;
    case 'logs':
      await showLogs(args[1], args[2]);
      break;
    case 'inspect':
      await inspectServer(args[1]);
      break;
    case 'openapi':
    case 'from-openapi':
      await runOpenApiServer(args[1], args.slice(2));
      break;
    case 'clean':
      await cleanRegistry();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log('mcponce v1.0.0');
      break;
    default:
      console.error(`Unknown command: ${args[0]}\n`);
      printHelp();
      process.exit(1);
  }
}

const isDirectCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('bin.js') ||
    process.argv[1].endsWith('bin.ts') ||
    process.argv[1].endsWith('mcponce'));

if (isDirectCli) {
  main().catch((err) => {
    console.error('Error:', err.message || err);
    process.exit(1);
  });
}
