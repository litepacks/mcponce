import type { ResolvedConfig } from '../runtime/config.js';
import { printInfo } from './info.js';
import { printLogs } from './logs.js';
import { printAnalytics } from './analytics.js';
import { executeCliToolCall, printToolsList } from './tool-caller.js';
import { installClientConfig, uninstallClientConfig } from './installer.js';

export interface CliOptions {
  isCliCommand: boolean;
  devMode: boolean;
  noSingleton: boolean;
  background: boolean;
}

export async function handleCliArgs(
  args: string[],
  config: ResolvedConfig<any>,
  app?: any
): Promise<CliOptions> {
  const first = args[0]?.toLowerCase();

  if (first === 'help' || first === '--help' || first === '-h') {
    console.log(`Usage: ${config.name} [command|options]`);
    console.log('');
    console.log('Commands:');
    console.log('  install [client]    Install this server into Claude Desktop or Cursor configs');
    console.log('  uninstall [client]  Remove this server from Claude Desktop or Cursor configs');
    console.log('  call <tool> [args]  Execute a registered tool directly with parameters');
    console.log('  tools               List all registered tools, descriptions, and schemas');
    console.log('  info                Show running server status, PID, and port');
    console.log('  analytics           Show tool performance, durations, and call graph');
    console.log('  start               Start server in background');
    console.log('  stop                Stop the running server instance');
    console.log('  restart             Restart the server instance');
    console.log('  inspect             Start server and open interactive Web Inspector');
    console.log('  logs [limit]        View recent server logs');
    console.log('');
    console.log('Options:');
    console.log('  -b, --background  Run or start as a detached background process');
    console.log('  --dev             Run with diagnostic logging to stderr');
    console.log('  --no-singleton    Disable single-instance locking (testing only)');
    console.log('  --help, -h        Show this help message');
    console.log('  --version, -v     Show server version');
    console.log('');
    console.log('When run without subcommands, runs as an MCP single-executable server/bridge.');
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'install') {
    const clientArg = args[1] && !args[1].startsWith('--') ? args[1] : 'all';
    const dryRun = args.includes('--dry-run');
    const project = args.includes('--project');
    const background = !args.includes('--no-background');
    const customPathIdx = args.indexOf('--config-path');
    const customPath = customPathIdx !== -1 ? args[customPathIdx + 1] : undefined;

    try {
      const results = installClientConfig({
        serverName: config.name,
        entrypoint: config.entrypoint || process.argv[1],
        client: clientArg,
        background,
        project,
        dryRun,
        customPath
      });

      console.log(`\n\x1b[1m\x1b[32m✔\x1b[0m ${dryRun ? '[Dry-run] Would configure' : 'Configured'} "${config.name}" in MCP client(s):\n`);
      for (const r of results) {
        console.log(`  \x1b[1m${r.client}\x1b[0m: ${r.configPath}`);
        console.log(`    Command: ${r.serverEntry.command} ${r.serverEntry.args.join(' ')}\n`);
      }
    } catch (err: any) {
      console.error(`Failed to install client config:`, err.message || err);
      process.exit(1);
    }
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'uninstall') {
    const clientArg = args[1] && !args[1].startsWith('--') ? args[1] : 'all';
    const dryRun = args.includes('--dry-run');
    const project = args.includes('--project');
    const customPathIdx = args.indexOf('--config-path');
    const customPath = customPathIdx !== -1 ? args[customPathIdx + 1] : undefined;

    try {
      const results = uninstallClientConfig({
        serverName: config.name,
        client: clientArg,
        project,
        dryRun,
        customPath
      });

      for (const r of results) {
        if (r.removed) {
          console.log(`\x1b[32m✔\x1b[0m Removed "${config.name}" from ${r.client} (${r.configPath})`);
        } else {
          console.log(`\x1b[90m○\x1b[0m "${config.name}" was not found in ${r.client} (${r.configPath})`);
        }
      }
    } catch (err: any) {
      console.error(`Failed to uninstall client config:`, err.message || err);
      process.exit(1);
    }
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'version' || first === '--version' || first === '-v') {
    console.log(`${config.name} v${config.version}`);
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'call') {
    if (!app) {
      console.error('Tool execution requires an active application instance.');
      process.exit(1);
    }
    let toolName = args[1];
    let toolArgs = args.slice(2);
    // Seamlessly support both "call <tool>" and "call <serverName> <tool>"
    if (args[2] && (toolName === config.name || (app.getTool && !app.getTool(toolName) && app.getTool(args[2])))) {
      toolName = args[2];
      toolArgs = args.slice(3);
    }
    await executeCliToolCall(app, toolName, toolArgs);
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'tools' || first === 'list-tools') {
    if (!app) {
      console.error('Listing tools requires an active application instance.');
      process.exit(1);
    }
    printToolsList(app.getTools ? app.getTools() : []);
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'info') {
    await printInfo(config);
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'analytics') {
    await printAnalytics(config, args.includes('--json'));
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'logs') {
    const limit = args[1] ? parseInt(args[1], 10) : 50;
    await printLogs(config, isNaN(limit) ? 50 : limit);
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'inspect') {
    if (!app) {
      console.error('Inspect command requires an active application instance.');
      process.exit(1);
    }
    try {
      const res = await app.start({ background: false });
      const url = app.getInspectorUrl(res.host);
      console.log(`\n\x1b[1m\x1b[32m✔\x1b[0m mcponce Web Inspector running at: \x1b[4m\x1b[36m${url}\x1b[0m\n`);
      const shouldOpen = !args.includes('--no-open');
      if (shouldOpen) {
        const { openBrowser } = await import('../utils/browser.js');
        await openBrowser(url);
      }
    } catch (err: any) {
      console.error(`Failed to start inspector:`, err.message || err);
      process.exit(1);
    }
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'start' && app) {
    try {
      const explicitNoBackground = args.includes('--no-background');
      const background = !explicitNoBackground;
      const res = await app.start({ background });
      if (res.reused) {
        console.log(`Server "${config.name}" is already running on http://${res.host}:${res.port} (PID ${res.pid}).`);
      } else {
        console.log(`Server "${config.name}" started in background on http://${res.host}:${res.port} (PID ${res.pid}).`);
      }
    } catch (err: any) {
      console.error(`Failed to start "${config.name}":`, err.message || err);
      process.exit(1);
    }
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'stop' && app) {
    try {
      await app.stop();
      console.log(`Server "${config.name}" stopped.`);
    } catch (err: any) {
      console.error(`Failed to stop "${config.name}":`, err.message || err);
      process.exit(1);
    }
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  if (first === 'restart' && app) {
    try {
      const res = await app.restart();
      console.log(`Server "${config.name}" restarted on http://${res.host}:${res.port} (PID ${res.pid}).`);
    } catch (err: any) {
      console.error(`Failed to restart "${config.name}":`, err.message || err);
      process.exit(1);
    }
    return { isCliCommand: true, devMode: false, noSingleton: false, background: false };
  }

  const background = args.includes('--background') || args.includes('-b');
  const devMode = args.includes('--dev');
  const noSingleton = args.includes('--no-singleton');

  return {
    isCliCommand: false,
    devMode,
    noSingleton,
    background
  };
}
