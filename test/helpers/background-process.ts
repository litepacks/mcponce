import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

interface ServiceOptions {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logs: { stdout: string; stderr: string };
}

interface Worker {
  child: ChildProcess;
  closed: Promise<void>;
}

/** Replace only the OS service manager. Workers, HTTP, locks and MCP stay real. */
export function createProcessServiceManager() {
  const services = new Map<string, Worker>();
  const workers: Worker[] = [];

  async function terminate(worker: Worker, signal: NodeJS.Signals = 'SIGTERM') {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      await worker.closed;
      return;
    }
    worker.child.kill(signal);
    // Wait for actual exit; ChildProcess.killed only means a signal was sent.
    const forceKill = setTimeout(() => worker.child.kill('SIGKILL'), 3000);
    try {
      await worker.closed;
    } finally {
      clearTimeout(forceKill);
    }
  }

  const adapter = {
    install: vi.fn(async (options: ServiceOptions) => {
      const previous = services.get(options.name);
      if (previous) await terminate(previous);
      fs.mkdirSync(path.dirname(options.logs.stdout), { recursive: true });
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const worker: Worker = {
        child,
        closed: new Promise<void>((resolve) => child.once('close', () => resolve()))
      };
      workers.push(worker);
      services.set(options.name, worker);
      child.stdout!.on('data', (chunk) => fs.appendFileSync(options.logs.stdout, chunk));
      child.stderr!.on('data', (chunk) => fs.appendFileSync(options.logs.stderr, chunk));
      await once(child, 'spawn');
      // Return before readiness, just like service installation. mcponce must
      // release its startup lock and wait for the worker's /health endpoint.
    }),
    stop: vi.fn(async (name: string) => {
      const worker = services.get(name);
      if (worker) await terminate(worker);
    }),
    uninstall: vi.fn(async (name: string) => {
      const worker = services.get(name);
      if (worker) await terminate(worker);
      services.delete(name);
    }),
    status: vi.fn(async (name: string) => {
      const worker = services.get(name);
      return {
        installed: Boolean(worker),
        running: Boolean(worker && worker.child.exitCode === null && worker.child.signalCode === null),
        pid: worker?.child.pid
      };
    })
  };

  return {
    adapter,
    async crash(name: string) {
      const worker = services.get(name);
      if (!worker) throw new Error(`No test worker for ${name}`);
      await terminate(worker, 'SIGKILL');
    },
    async dispose() {
      await Promise.all(workers.map((worker) => terminate(worker)));
    }
  };
}

/** Every generated entrypoint has isolated state and forbids native services. */
export function writeBackgroundEntrypoint(name: string, dataDir: string) {
  const scriptPath = path.join(dataDir, 'server.mjs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(scriptPath, `
import { createMcpServer } from ${JSON.stringify(new URL('../../dist/index.js', import.meta.url).href)};
import { _setUnitupModule } from ${JSON.stringify(new URL('../../dist/runtime/unitup.js', import.meta.url).href)};

_setUnitupModule({
  install: async () => { throw new Error('Test worker must not install a native service'); },
  stop: async () => {},
  uninstall: async () => {}
});

let initializations = 0;
const app = createMcpServer({
  name: ${JSON.stringify(name)},
  dataDir: ${JSON.stringify(dataDir)},
  logging: { directory: ${JSON.stringify(path.join(dataDir, 'logs'))} },
  host: '127.0.0.1',
  port: 0,
  background: true,
  registerInCentral: false,
  context: () => ({ initializations: ++initializations, counter: { calls: 0 } })
});
app.tool({
  name: 'ping',
  description: 'Report worker identity and shared context for lifecycle tests',
  inputSchema: {},
  handler: (_args, context) => ({
    pid: process.pid,
    initializations: context.initializations,
    calls: ++context.counter.calls
  })
});
await app.run();
`);
  return scriptPath;
}
