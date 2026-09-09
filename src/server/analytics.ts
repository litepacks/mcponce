import type {
  ToolInvocationStatus,
  ToolMetric,
  InterToolRelationship,
  RecentToolInvocation,
  ServerAnalyticsSummary,
  ServerAnalytics,
  PrometheusExportOptions
} from '../types.js';

export interface RecordInvocationOptions {
  tool: string;
  caller?: string;
  durationMs: number;
  status: ToolInvocationStatus;
  errorMessage?: string;
  isCacheHit?: boolean;
  retries?: number;
}

export class AnalyticsCollector {
  private startedAt: string;
  private invocationCounter = 0;
  private readonly maxRecentEntries: number;

  private totalInvocations = 0;
  private successfulInvocations = 0;
  private failedInvocations = 0;
  private timeoutInvocations = 0;
  private cancelledInvocations = 0;
  private cachedInvocations = 0;
  private totalRetries = 0;
  private totalExecutionTimeMs = 0;
  private totalInterToolCalls = 0;

  private tools = new Map<string, ToolMetric>();
  private interToolMap = new Map<string, number>(); // key: "caller->target"
  private recentInvocations: RecentToolInvocation[] = [];

  constructor(options: { maxRecentEntries?: number } = {}) {
    this.startedAt = new Date().toISOString();
    this.maxRecentEntries = options.maxRecentEntries ?? 50;
  }

  /**
   * Records a completed tool execution into the analytics store.
   */
  recordInvocation(options: RecordInvocationOptions): RecentToolInvocation {
    const { tool, caller, durationMs, status, errorMessage } = options;
    this.invocationCounter++;

    // 1. Update summary counters
    this.totalInvocations++;
    this.totalExecutionTimeMs += durationMs;

    if (options.isCacheHit) {
      this.cachedInvocations++;
    }
    if (options.retries) {
      this.totalRetries += options.retries;
    }

    if (status === 'success') {
      this.successfulInvocations++;
    } else if (status === 'timeout') {
      this.timeoutInvocations++;
      this.failedInvocations++;
    } else if (status === 'cancelled') {
      this.cancelledInvocations++;
      this.failedInvocations++;
    } else {
      this.failedInvocations++;
    }

    // 2. Update per-tool metrics
    let metric = this.tools.get(tool);
    if (!metric) {
      metric = {
        name: tool,
        calls: 0,
        success: 0,
        errors: 0,
        timeouts: 0,
        cancellations: 0,
        cacheHits: 0,
        retries: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        minDurationMs: durationMs,
        maxDurationMs: durationMs,
        lastDurationMs: durationMs,
        callers: {},
        invokedTools: {}
      };
      this.tools.set(tool, metric);
    }

    metric.calls++;
    if (options.isCacheHit) {
      metric.cacheHits = (metric.cacheHits || 0) + 1;
    }
    if (options.retries) {
      metric.retries = (metric.retries || 0) + options.retries;
    }
    if (status === 'success') {
      metric.success++;
    } else if (status === 'timeout') {
      metric.timeouts++;
      metric.errors++;
    } else if (status === 'cancelled') {
      metric.cancellations++;
      metric.errors++;
    } else {
      metric.errors++;
    }

    metric.totalDurationMs += durationMs;
    metric.avgDurationMs = Math.round((metric.totalDurationMs / metric.calls) * 100) / 100;
    metric.minDurationMs = Math.min(metric.minDurationMs, durationMs);
    metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
    metric.lastDurationMs = durationMs;
    metric.lastInvokedAt = new Date().toISOString();

    // 3. Update inter-tool calls (call graph)
    if (caller) {
      this.totalInterToolCalls++;
      metric.callers[caller] = (metric.callers[caller] || 0) + 1;

      // Update caller's invokedTools mapping if caller is a known tool
      let callerMetric = this.tools.get(caller);
      if (!callerMetric) {
        callerMetric = {
          name: caller,
          calls: 0,
          success: 0,
          errors: 0,
          timeouts: 0,
          cancellations: 0,
          totalDurationMs: 0,
          avgDurationMs: 0,
          minDurationMs: 0,
          maxDurationMs: 0,
          lastDurationMs: 0,
          callers: {},
          invokedTools: {}
        };
        this.tools.set(caller, callerMetric);
      }
      callerMetric.invokedTools[tool] = (callerMetric.invokedTools[tool] || 0) + 1;

      const edgeKey = `${caller}->${tool}`;
      this.interToolMap.set(edgeKey, (this.interToolMap.get(edgeKey) || 0) + 1);
    }

    // 4. Append to recent invocations ring buffer
    const recentEntry: RecentToolInvocation = {
      id: this.invocationCounter,
      tool,
      caller: caller || undefined,
      durationMs,
      status,
      timestamp: new Date().toISOString(),
      errorMessage,
      isCacheHit: options.isCacheHit,
      retries: options.retries
    };

    this.recentInvocations.push(recentEntry);
    if (this.recentInvocations.length > this.maxRecentEntries) {
      this.recentInvocations.shift();
    }

    return recentEntry;
  }

  /**
   * Returns a complete, read-only snapshot of server analytics.
   */
  getSnapshot(): ServerAnalytics {
    const averageExecutionTimeMs =
      this.totalInvocations > 0
        ? Math.round((this.totalExecutionTimeMs / this.totalInvocations) * 100) / 100
        : 0;

    const summary: ServerAnalyticsSummary = {
      totalInvocations: this.totalInvocations,
      successfulInvocations: this.successfulInvocations,
      failedInvocations: this.failedInvocations,
      timeoutInvocations: this.timeoutInvocations,
      cancelledInvocations: this.cancelledInvocations,
      cachedInvocations: this.cachedInvocations,
      totalRetries: this.totalRetries,
      totalExecutionTimeMs: this.totalExecutionTimeMs,
      averageExecutionTimeMs,
      totalInterToolCalls: this.totalInterToolCalls
    };

    const toolsObj: Record<string, ToolMetric> = {};
    for (const [name, metric] of this.tools.entries()) {
      toolsObj[name] = {
        ...metric,
        callers: { ...metric.callers },
        invokedTools: { ...metric.invokedTools }
      };
    }

    const interToolCalls: InterToolRelationship[] = [];
    for (const [key, count] of this.interToolMap.entries()) {
      const [caller, target] = key.split('->');
      interToolCalls.push({ caller, target, count });
    }

    // Sort interToolCalls by count descending
    interToolCalls.sort((a, b) => b.count - a.count);

    return {
      startedAt: this.startedAt,
      generatedAt: new Date().toISOString(),
      summary,
      tools: toolsObj,
      interToolCalls,
      recentInvocations: [...this.recentInvocations]
    };
  }

  /**
   * Generates standard Prometheus exposition format (version 0.0.4) text representation.
   */
  toPrometheusFormat(options: PrometheusExportOptions = {}): string {
    const lines: string[] = [];
    const server = options.serverName ? escapePrometheus(options.serverName) : 'mcponce';

    // 1. Server info & metadata
    lines.push('# HELP mcp_server_info Metadata and version information for this MCP server.');
    lines.push('# TYPE mcp_server_info gauge');
    const versionLabel = options.version ? `,version="${escapePrometheus(options.version)}"` : '';
    lines.push(`mcp_server_info{server="${server}"${versionLabel}} 1`);
    lines.push('');

    // 2. Server uptime & sessions
    if (options.uptimeSeconds !== undefined) {
      lines.push('# HELP mcp_server_uptime_seconds Server uptime in seconds.');
      lines.push('# TYPE mcp_server_uptime_seconds gauge');
      lines.push(`mcp_server_uptime_seconds{server="${server}"} ${options.uptimeSeconds.toFixed(2)}`);
      lines.push('');
    }

    if (options.activeSessions !== undefined) {
      lines.push('# HELP mcp_active_sessions Current number of active client sessions.');
      lines.push('# TYPE mcp_active_sessions gauge');
      lines.push(`mcp_active_sessions{server="${server}"} ${options.activeSessions}`);
      lines.push('');
    }

    if (options.totalSessions !== undefined) {
      lines.push('# HELP mcp_sessions_total Total client sessions established since start.');
      lines.push('# TYPE mcp_sessions_total counter');
      lines.push(`mcp_sessions_total{server="${server}"} ${options.totalSessions}`);
      lines.push('');
    }

    // 3. Summary tool invocations by status
    lines.push('# HELP mcp_tool_invocations_total Overall tool invocations processed by the server.');
    lines.push('# TYPE mcp_tool_invocations_total counter');
    lines.push(`mcp_tool_invocations_total{server="${server}",status="success"} ${this.successfulInvocations}`);
    lines.push(`mcp_tool_invocations_total{server="${server}",status="error"} ${this.failedInvocations}`);
    lines.push(`mcp_tool_invocations_total{server="${server}",status="timeout"} ${this.timeoutInvocations}`);
    lines.push(`mcp_tool_invocations_total{server="${server}",status="cancelled"} ${this.cancelledInvocations}`);
    lines.push('');

    // 4. Per-tool calls breakdown
    lines.push('# HELP mcp_tool_calls_total Total invocations per tool partitioned by status.');
    lines.push('# TYPE mcp_tool_calls_total counter');
    for (const [name, m] of this.tools.entries()) {
      const toolName = escapePrometheus(name);
      lines.push(`mcp_tool_calls_total{server="${server}",tool="${toolName}",status="success"} ${m.success}`);
      lines.push(`mcp_tool_calls_total{server="${server}",tool="${toolName}",status="error"} ${m.errors}`);
      lines.push(`mcp_tool_calls_total{server="${server}",tool="${toolName}",status="timeout"} ${m.timeouts}`);
      lines.push(`mcp_tool_calls_total{server="${server}",tool="${toolName}",status="cancelled"} ${m.cancellations}`);
    }
    lines.push('');

    // 5. Per-tool execution duration
    lines.push('# HELP mcp_tool_duration_seconds_total Total duration in seconds spent executing each tool.');
    lines.push('# TYPE mcp_tool_duration_seconds_total counter');
    for (const [name, m] of this.tools.entries()) {
      const toolName = escapePrometheus(name);
      lines.push(`mcp_tool_duration_seconds_total{server="${server}",tool="${toolName}"} ${(m.totalDurationMs / 1000).toFixed(6)}`);
    }
    lines.push('');

    // 6. Per-tool average duration
    lines.push('# HELP mcp_tool_duration_seconds_avg Average duration in seconds per invocation.');
    lines.push('# TYPE mcp_tool_duration_seconds_avg gauge');
    for (const [name, m] of this.tools.entries()) {
      const toolName = escapePrometheus(name);
      lines.push(`mcp_tool_duration_seconds_avg{server="${server}",tool="${toolName}"} ${(m.avgDurationMs / 1000).toFixed(6)}`);
    }
    lines.push('');

    // 7. Per-tool cache hits
    lines.push('# HELP mcp_tool_cache_hits_total Number of in-memory response cache hits per tool.');
    lines.push('# TYPE mcp_tool_cache_hits_total counter');
    for (const [name, m] of this.tools.entries()) {
      const toolName = escapePrometheus(name);
      lines.push(`mcp_tool_cache_hits_total{server="${server}",tool="${toolName}"} ${m.cacheHits || 0}`);
    }
    lines.push('');

    // 8. Per-tool retries
    lines.push('# HELP mcp_tool_retries_total Automatic retry attempts executed for transient errors.');
    lines.push('# TYPE mcp_tool_retries_total counter');
    for (const [name, m] of this.tools.entries()) {
      const toolName = escapePrometheus(name);
      lines.push(`mcp_tool_retries_total{server="${server}",tool="${toolName}"} ${m.retries || 0}`);
    }
    lines.push('');

    // 9. Inter-tool calls
    if (this.interToolMap.size > 0) {
      lines.push('# HELP mcp_inter_tool_calls_total Tool-to-tool invocations executed.');
      lines.push('# TYPE mcp_inter_tool_calls_total counter');
      for (const [edge, count] of this.interToolMap.entries()) {
        const [caller, target] = edge.split('->');
        lines.push(`mcp_inter_tool_calls_total{server="${server}",caller="${escapePrometheus(caller)}",target="${escapePrometheus(target)}"} ${count}`);
      }
      lines.push('');
    }

    // 10. Cache manager stats
    if (options.cacheStats) {
      lines.push('# HELP mcp_cache_entries Total number of responses currently stored in cache.');
      lines.push('# TYPE mcp_cache_entries gauge');
      lines.push(`mcp_cache_entries{server="${server}"} ${options.cacheStats.size}`);
      lines.push('');

      lines.push('# HELP mcp_cache_hits_total Cache hit count across all tools.');
      lines.push('# TYPE mcp_cache_hits_total counter');
      lines.push(`mcp_cache_hits_total{server="${server}"} ${options.cacheStats.hits}`);
      lines.push('');

      lines.push('# HELP mcp_cache_misses_total Cache miss count across all tools.');
      lines.push('# TYPE mcp_cache_misses_total counter');
      lines.push(`mcp_cache_misses_total{server="${server}"} ${options.cacheStats.misses}`);
      lines.push('');

      lines.push('# HELP mcp_cache_evictions_total Number of cache entries evicted due to size limits.');
      lines.push('# TYPE mcp_cache_evictions_total counter');
      lines.push(`mcp_cache_evictions_total{server="${server}"} ${options.cacheStats.evictions}`);
      lines.push('');
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Clears and resets all recorded metrics.
   */
  reset(): void {
    this.startedAt = new Date().toISOString();
    this.invocationCounter = 0;
    this.totalInvocations = 0;
    this.successfulInvocations = 0;
    this.failedInvocations = 0;
    this.timeoutInvocations = 0;
    this.cancelledInvocations = 0;
    this.cachedInvocations = 0;
    this.totalRetries = 0;
    this.totalExecutionTimeMs = 0;
    this.totalInterToolCalls = 0;
    this.tools.clear();
    this.interToolMap.clear();
    this.recentInvocations = [];
  }
}

function escapePrometheus(val: string): string {
  return String(val)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}
