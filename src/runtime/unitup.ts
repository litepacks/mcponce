import path from 'node:path';
import type { ResolvedConfig } from './config.js';

let _overrideUnitup: any = undefined; // undefined = use dynamic import, null = force missing

/**
 * For testing purposes: mock or simulate missing Unitup.
 */
export function _setUnitupModule(mod: any | null): void {
  _overrideUnitup = mod;
}

/**
 * For testing purposes: reset Unitup module override.
 */
export function _resetUnitupModule(): void {
  _overrideUnitup = undefined;
}

/**
 * Checks if Unitup is installed and available.
 */
export async function isUnitupInstalled(): Promise<boolean> {
  if (_overrideUnitup !== undefined) {
    return _overrideUnitup !== null;
  }
  try {
    await import('unitup');
    return true;
  } catch {
    return false;
  }
}

/**
 * Dynamically imports Unitup or throws a user-friendly error.
 */
export async function getUnitup(): Promise<any> {
  if (_overrideUnitup !== undefined) {
    if (_overrideUnitup === null) {
      throw new Error(
        'Background mode requires Unitup, but Unitup is not installed.\n\nInstall it with:\n\nnpm install unitup'
      );
    }
    return _overrideUnitup;
  }
  try {
    return await import('unitup');
  } catch {
    throw new Error(
      'Background mode requires Unitup, but Unitup is not installed.\n\nInstall it with:\n\nnpm install unitup'
    );
  }
}

export interface UnitupProcessOptions {
  name: string;
  command?: string;
  args?: string[];
  scriptPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  dataDir: string;
  logDir: string;
}

export function getUnitupServiceName(name: string): string {
  return `mcponce-${name}`;
}

/**
 * Starts the shared MCP server entrypoint in detached background mode using Unitup.
 */
export async function startBackgroundProcess(options: UnitupProcessOptions): Promise<void> {
  const unitup = await getUnitup();
  const serviceName = getUnitupServiceName(options.name);

  const scriptPath = options.scriptPath || process.argv[1];
  const command = options.command || process.execPath;

  const args = [
    ...process.execArgv,
    scriptPath,
    ...(options.args || []),
    '--mcponce-background'
  ];

  const cwd = options.cwd || process.cwd();
  const stdoutLog = path.join(options.logDir, 'unitup.stdout.log');
  const stderrLog = path.join(options.logDir, 'unitup.stderr.log');

  const env = {
    ...process.env,
    ...(options.env || {}),
    MCPONCE_BACKGROUND_SERVER: '1'
  };

  await unitup.install({
    name: serviceName,
    command,
    args,
    cwd,
    env,
    logs: {
      stdout: stdoutLog,
      stderr: stderrLog
    },
    start: true,
    force: true
  });
}

/**
 * Stops and uninstalls the Unitup background service.
 */
export async function stopBackgroundProcess(name: string): Promise<boolean> {
  try {
    const unitup = await getUnitup();
    const serviceName = getUnitupServiceName(name);
    try {
      await unitup.stop(serviceName);
    } catch {}
    try {
      await unitup.uninstall(serviceName, { force: true });
    } catch {}
    return true;
  } catch {
    return false;
  }
}

/**
 * Restarts the Unitup background service.
 */
export async function restartBackgroundProcess(options: UnitupProcessOptions): Promise<void> {
  const unitup = await getUnitup();
  const serviceName = getUnitupServiceName(options.name);
  try {
    await unitup.restart(serviceName);
  } catch {
    await stopBackgroundProcess(options.name);
    await startBackgroundProcess(options);
  }
}

/**
 * Retrieves the Unitup service status.
 */
export async function getBackgroundStatus(name: string): Promise<any | null> {
  try {
    const unitup = await getUnitup();
    const serviceName = getUnitupServiceName(name);
    return await unitup.status(serviceName);
  } catch {
    return null;
  }
}
