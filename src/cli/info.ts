import type { ResolvedConfig } from '../runtime/config.js';
import { StateManager } from '../runtime/state.js';
import { checkHealth, fetchInfo } from '../runtime/health.js';

export async function printInfo(config: ResolvedConfig<any>): Promise<void> {
  const stateManager = new StateManager(config.dataDir);
  const state = stateManager.read();

  if (!state) {
    console.log(`Name: ${config.name}`);
    console.log(`Status: stopped`);
    console.log(`Data directory: ${config.dataDir}`);
    console.log(`Log directory: ${config.logDir}`);
    return;
  }

  const health = await checkHealth(state.host, state.port, config.name, 1500);

  if (!health) {
    console.log(`Name: ${config.name}`);
    console.log(`Status: stopped (stale state found for pid ${state.pid})`);
    console.log(`Data directory: ${config.dataDir}`);
    console.log(`Log directory: ${config.logDir}`);
    return;
  }

  const info = await fetchInfo(state.host, state.port, 1500);

  console.log(`Name: ${state.name}`);
  console.log(`Status: running`);
  console.log(`PID: ${state.pid}`);
  console.log(`Port: ${state.port}`);
  console.log(`Host: ${state.host}`);
  console.log(`Started: ${state.startedAt}`);
  console.log(`Data directory: ${config.dataDir}`);
  console.log(`Log directory: ${config.logDir}`);
  console.log(`Active sessions: ${info?.activeSessions ?? 'unknown'}`);
  console.log(`Total sessions: ${info?.totalSessions ?? 'unknown'}`);
  if (info?.lastClientConnection) {
    console.log(`Last connection: ${info.lastClientConnection}`);
  }
  if (info?.lastToolInvocation) {
    console.log(
      `Last tool invocation: ${info.lastToolInvocation.name} at ${info.lastToolInvocation.timestamp}`
    );
  }
  if (info?.analytics) {
    console.log(
      `Tool calls: ${info.analytics.totalInvocations} (${info.analytics.successfulInvocations} ok, ${info.analytics.failedInvocations} err, avg ${info.analytics.averageExecutionTimeMs}ms)`
    );
  }
}
