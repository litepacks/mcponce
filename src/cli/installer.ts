import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type SupportedClient = 'claude' | 'cursor' | 'antigravity' | 'all';

export interface ClientTargetInfo {
  name: string;
  path: string;
}

export interface InstallClientOptions {
  client?: SupportedClient | string;
  serverName: string;
  entrypoint: string;
  background?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  dryRun?: boolean;
  project?: boolean;
  customPath?: string;
}

export interface InstallResult {
  client: string;
  configPath: string;
  updated: boolean;
  serverEntry: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

export interface UninstallClientOptions {
  client?: SupportedClient | string;
  serverName: string;
  dryRun?: boolean;
  project?: boolean;
  customPath?: string;
}

export interface UninstallResult {
  client: string;
  configPath: string;
  removed: boolean;
}

/**
 * Resolves standard configuration file paths for supported MCP clients across OSes.
 */
export function getClientConfigPath(client: string, project = false): string {
  const platform = process.platform;
  const home = os.homedir();

  const c = client.toLowerCase();

  if (c === 'claude' || c === 'claude-desktop') {
    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'Claude', 'claude_desktop_config.json');
    }
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(configHome, 'Claude', 'claude_desktop_config.json');
  }

  if (c === 'cursor') {
    if (project) {
      return path.resolve(process.cwd(), '.cursor', 'mcp.json');
    }
    if (platform === 'darwin') {
      return path.join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'mcp.json'
      );
    }
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'Cursor', 'User', 'globalStorage', 'mcp.json');
    }
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(configHome, 'Cursor', 'User', 'globalStorage', 'mcp.json');
  }

  if (c === 'antigravity') {
    return path.join(home, '.gemini', 'antigravity-ide', 'mcp_config.json');
  }

  throw new Error(`Unsupported client: "${client}". Supported clients: claude, cursor, antigravity, all`);
}

/**
 * Returns a list of target clients and their config paths based on selection.
 */
export function resolveClientTargets(
  client: SupportedClient | string = 'all',
  project = false,
  customPath?: string
): ClientTargetInfo[] {
  if (customPath) {
    return [{ name: client || 'custom', path: path.resolve(customPath) }];
  }

  const c = client.toLowerCase();
  if (c === 'all') {
    return [
      { name: 'claude', path: getClientConfigPath('claude', project) },
      { name: 'cursor', path: getClientConfigPath('cursor', project) }
    ];
  }

  return [{ name: c, path: getClientConfigPath(c, project) }];
}

/**
 * Reads and parses an MCP client config file. Returns empty object if file does not exist.
 */
export function readClientConfig(configPath: string): Record<string, any> {
  if (!fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8').trim();
    if (!raw) {
      return { mcpServers: {} };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { mcpServers: {} };
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      parsed.mcpServers = {};
    }
    return parsed;
  } catch (err: any) {
    throw new Error(`Failed to parse MCP configuration file at "${configPath}": ${err.message}`);
  }
}

/**
 * Writes updated configuration to disk, ensuring directory structure exists.
 */
export function writeClientConfig(configPath: string, config: Record<string, any>): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Programmatically installs an mcponce server into one or more MCP client configs.
 */
export function installClientConfig(options: InstallClientOptions): InstallResult[] {
  const {
    serverName,
    entrypoint,
    client = 'all',
    background = true,
    project = false,
    dryRun = false,
    customPath,
    env
  } = options;

  if (!serverName || typeof serverName !== 'string') {
    throw new Error('serverName is required to install client configuration');
  }

  if (!entrypoint || typeof entrypoint !== 'string') {
    throw new Error('entrypoint script path is required to install client configuration');
  }

  const resolvedEntrypoint = path.resolve(entrypoint);
  const targets = resolveClientTargets(client, project, customPath);
  const results: InstallResult[] = [];

  const isTs = resolvedEntrypoint.endsWith('.ts');
  const command = options.command || (isTs ? 'npx' : 'node');

  let args: string[] = [];
  if (options.args) {
    args = [...options.args];
  } else if (isTs) {
    args = ['tsx', resolvedEntrypoint];
    if (background) args.push('--background');
  } else {
    args = [resolvedEntrypoint];
    if (background) args.push('--background');
  }

  const serverEntry: { command: string; args: string[]; env?: Record<string, string> } = {
    command,
    args
  };
  if (env && Object.keys(env).length > 0) {
    serverEntry.env = env;
  }

  for (const target of targets) {
    const config = readClientConfig(target.path);
    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    config.mcpServers[serverName] = serverEntry;

    if (!dryRun) {
      writeClientConfig(target.path, config);
    }

    results.push({
      client: target.name,
      configPath: target.path,
      updated: true,
      serverEntry
    });
  }

  return results;
}

/**
 * Removes an mcponce server from one or more MCP client configs.
 */
export function uninstallClientConfig(options: UninstallClientOptions): UninstallResult[] {
  const {
    serverName,
    client = 'all',
    project = false,
    dryRun = false,
    customPath
  } = options;

  if (!serverName) {
    throw new Error('serverName is required to uninstall client configuration');
  }

  const targets = resolveClientTargets(client, project, customPath);
  const results: UninstallResult[] = [];

  for (const target of targets) {
    if (!fs.existsSync(target.path)) {
      results.push({
        client: target.name,
        configPath: target.path,
        removed: false
      });
      continue;
    }

    const config = readClientConfig(target.path);
    let removed = false;

    if (config.mcpServers && config.mcpServers[serverName]) {
      delete config.mcpServers[serverName];
      removed = true;

      if (!dryRun) {
        writeClientConfig(target.path, config);
      }
    }

    results.push({
      client: target.name,
      configPath: target.path,
      removed
    });
  }

  return results;
}
