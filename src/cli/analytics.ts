import type { ResolvedConfig } from '../runtime/config.js';
import { StateManager } from '../runtime/state.js';
import { checkHealth } from '../runtime/health.js';
import type { ServerAnalytics } from '../types.js';

export async function fetchAnalytics(host: string, port: number, timeoutMs = 1500): Promise<ServerAnalytics | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/analytics`, {
      signal: controller.signal
    });
    if (!res.ok) return null;
    return (await res.json()) as ServerAnalytics;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function renderAnalyticsOutput(
  name: string,
  pid: number | undefined,
  host: string,
  port: number,
  analytics: ServerAnalytics
): void {
  const { summary, tools, interToolCalls, recentInvocations } = analytics;
  const toolList = Object.values(tools);

  console.log(`\n======================================================`);
  console.log(`  mcponce Analytics: ${name}${pid ? ` (PID: ${pid})` : ''}`);
  console.log(`  Server: http://${host}:${port} | Started: ${analytics.startedAt}`);
  console.log(`======================================================\n`);

  // 1. Summary Box
  const successRate =
    summary.totalInvocations > 0
      ? Math.round((summary.successfulInvocations / summary.totalInvocations) * 1000) / 10
      : 100;

  console.log(`Summary:`);
  console.log(`  Total Invocations:     ${summary.totalInvocations}`);
  console.log(`  Success Rate:          ${successRate}% (${summary.successfulInvocations} succeeded, ${summary.failedInvocations} failed)`);
  if (summary.timeoutInvocations > 0 || summary.cancelledInvocations > 0) {
    console.log(`  Timeouts / Cancels:    ${summary.timeoutInvocations} timed out, ${summary.cancelledInvocations} cancelled`);
  }
  console.log(`  Avg Execution Time:    ${summary.averageExecutionTimeMs}ms (Total: ${summary.totalExecutionTimeMs}ms)`);
  console.log(`  Inter-Tool Calls:      ${summary.totalInterToolCalls}`);
  console.log('');

  // 2. Per-Tool Metrics Table
  if (toolList.length === 0) {
    console.log(`No tool invocations recorded yet.\n`);
  } else {
    console.log(`Tool Performance:`);
    console.log(
      `  ${'Tool Name'.padEnd(24)} ${'Calls'.padStart(6)} ${'Success'.padStart(8)} ${'Errors'.padStart(7)} ${'Avg (ms)'.padStart(10)} ${'Min / Max (ms)'.padStart(16)}`
    );
    console.log(`  ${'-'.repeat(75)}`);

    for (const t of toolList) {
      const minMax = `${t.minDurationMs} / ${t.maxDurationMs}`;
      console.log(
        `  ${t.name.padEnd(24)} ${String(t.calls).padStart(6)} ${String(t.success).padStart(8)} ${String(t.errors).padStart(7)} ${String(t.avgDurationMs).padStart(10)} ${minMax.padStart(16)}`
      );
    }
    console.log('');
  }

  // 3. Inter-Tool Invocations (Call Graph)
  if (interToolCalls.length > 0) {
    console.log(`Inter-Tool Invocations (Call Graph):`);
    for (const rel of interToolCalls) {
      console.log(`  ${rel.caller} ──(${rel.count}x)──> ${rel.target}`);
    }
    console.log('');
  }

  // 4. Recent Invocations
  if (recentInvocations.length > 0) {
    const recentToShow = recentInvocations.slice(-10);
    console.log(`Recent Invocations (Last ${recentToShow.length}):`);
    for (const item of recentToShow) {
      const time = item.timestamp.split('T')[1]?.slice(0, 8) || item.timestamp;
      const callerTag = item.caller ? ` [from ${item.caller}]` : '';
      const statusIcon =
        item.status === 'success' ? '✓ OK' : item.status === 'timeout' ? '⏱ TIMEOUT' : item.status === 'cancelled' ? '🛑 CANCEL' : '✗ ERROR';
      const errMsg = item.errorMessage ? ` - ${item.errorMessage}` : '';
      console.log(`  [${time}] ${item.tool}${callerTag} (${item.durationMs}ms) [${statusIcon}]${errMsg}`);
    }
    console.log('');
  }
}

export async function printAnalytics(config: ResolvedConfig<any>, asJson = false): Promise<void> {
  const stateManager = new StateManager(config.dataDir);
  const state = stateManager.read();

  if (!state) {
    if (asJson) {
      console.log(JSON.stringify({ error: `Server "${config.name}" is stopped.` }));
    } else {
      console.log(`Server "${config.name}" is stopped.`);
    }
    return;
  }

  const health = await checkHealth(state.host, state.port, config.name, 1500);
  if (!health) {
    if (asJson) {
      console.log(JSON.stringify({ error: `Server "${config.name}" is stopped (stale state found for PID ${state.pid}).` }));
    } else {
      console.log(`Server "${config.name}" is stopped (stale state found for PID ${state.pid}).`);
    }
    return;
  }

  const analytics = await fetchAnalytics(state.host, state.port, 2000);
  if (!analytics) {
    if (asJson) {
      console.log(JSON.stringify({ error: `Failed to retrieve analytics from http://${state.host}:${state.port}/analytics` }));
    } else {
      console.log(`Failed to retrieve analytics from http://${state.host}:${state.port}/analytics`);
    }
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(analytics, null, 2));
    return;
  }

  renderAnalyticsOutput(config.name, state.pid, state.host, state.port, analytics);
}
