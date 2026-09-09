import os from 'node:os';
import path from 'node:path';

/**
 * Returns the default application data directory for the given application name,
 * matching platform conventions (macOS, Linux, Windows).
 */
export function getDefaultDataDir(
  appName: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  const home = os.homedir();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', appName);
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || (env.APPDATA ? path.join(env.APPDATA, '..', 'Local') : '');
    if (localAppData) {
      return path.join(localAppData, appName);
    }
    return path.join(home, 'AppData', 'Local', appName);
  }

  // Linux and other POSIX platforms
  const xdgState = env.XDG_STATE_HOME;
  if (xdgState) {
    return path.join(xdgState, appName);
  }
  return path.join(home, '.local', 'state', appName);
}

/**
 * Resolves the final data directory, respecting explicit configuration,
 * environment variables, and platform defaults.
 */
export function resolveDataDir(
  appName: string,
  explicitDataDir?: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (explicitDataDir) {
    return path.resolve(explicitDataDir);
  }

  const envDataDir = env.MCP_SERVER_DATA_DIR;
  if (envDataDir) {
    return path.resolve(envDataDir);
  }

  return getDefaultDataDir(appName, platform, env);
}

/**
 * Resolves the final log directory, respecting explicit configuration,
 * environment variables, and the default `<dataDir>/logs`.
 */
export function resolveLogDir(
  dataDir: string,
  explicitLogDir?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (explicitLogDir) {
    return path.resolve(explicitLogDir);
  }

  const envLogDir = env.MCP_SERVER_LOG_DIR;
  if (envLogDir) {
    return path.resolve(envLogDir);
  }

  return path.join(dataDir, 'logs');
}
