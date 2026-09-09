import { z } from 'zod';
import type {
  McpServerConfig,
  McpServerConfigInput,
  StartOptions,
  StopOptions,
  RestartOptions,
  ToolDefinition,
  InputSchemaDefinition,
  ShorthandInputSchema,
  ToolCallResult,
  ToolExtra,
  CallOptions,
  ResourceDefinition,
  ResourceTemplateDefinition,
  AnyResourceDefinition,
  ResourceMatchResult,
  ReadResourceResult,
  PromptDefinition,
  ServerStatus,
  StartResult,
  Logger,
  ServerAnalytics,
  ToolInvocationStatus,
  CacheStats,
  ToolMiddlewareContext,
  ToolMiddlewareHandler,
  MiddlewareFilter,
  CompletionResult,
  AuthIdentity
} from '../types.js';
import { verifyToolScopes } from '../utils/security.js';
import { resolveCompletion } from '../utils/completion.js';
import { AnalyticsCollector } from './analytics.js';
import { resolveConfig, type ResolvedConfig } from '../runtime/config.js';
import { InstanceCoordinator, type InstanceRole } from '../runtime/instance.js';
import { StateManager } from '../runtime/state.js';
import { LockManager } from '../runtime/lock.js';
import { checkHealth, fetchInfo, isPidRunning } from '../runtime/health.js';
import { DefaultLogger } from '../logging/logger.js';
import { ToolRegistry, normalizeInputSchema, type RegisteredTool } from '../registry/tools.js';
import { ResourceRegistry } from '../registry/resources.js';
import { SubscriptionRegistry } from '../registry/subscriptions.js';
import { PromptRegistry } from '../registry/prompts.js';
import { ContextManager } from './context.js';
import { normalizeToolResult } from './mcp.js';
import { normalizeResourceResult } from '../utils/media.js';
import { createHonoApp, type ServerMetrics } from './hono.js';
import {
  executeSample,
  executeListRoots,
  type SampleHandler,
  type ListRootsHandler,
  type Root,
  type SampleOptions,
  type SampleResult
} from '../utils/sampling.js';
import { createOpenApiTools, type OpenApiOptions } from '../utils/openapi.js';
import { startHttpServer, type HttpServerHandle } from '../transport/http.js';
import { startStdioProxy, type StdioProxyHandle } from '../transport/proxy.js';
import { handleCliArgs } from '../cli/index.js';
import { CentralRegistry } from '../registry/central.js';
import { QueueManager } from '../utils/queue.js';
import { ToolCacheManager } from '../utils/cache.js';
import { executeWithRetry, raceWithSignal } from '../utils/retry.js';
import { coerceArguments } from '../utils/coercion.js';
import { createProgressReporter } from '../utils/progress.js';
import { MiddlewareManager } from '../utils/middleware.js';
import {
  getUnitup,
  startBackgroundProcess,
  stopBackgroundProcess
} from '../runtime/unitup.js';
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export class McpApp<TContext = unknown> {
  readonly config: ResolvedConfig<TContext>;
  readonly logger: DefaultLogger;
  readonly toolRegistry: ToolRegistry<TContext>;
  readonly resourceRegistry = new ResourceRegistry<TContext>();
  readonly subscriptionRegistry = new SubscriptionRegistry();
  readonly promptRegistry = new PromptRegistry<TContext>();
  readonly contextManager: ContextManager<TContext>;
  readonly analytics = new AnalyticsCollector();
  readonly queueManager = new QueueManager();
  readonly cacheManager = new ToolCacheManager();
  readonly middlewareManager: MiddlewareManager<TContext>;
  private resourceUpdateListeners = new Set<(uri: string) => void>();

  private instanceCoordinator: InstanceCoordinator;
  private stateManager: StateManager;
  private lockManager: LockManager;
  private centralRegistry = new CentralRegistry();

  private httpHandle?: HttpServerHandle;
  private stdioProxyHandle?: StdioProxyHandle;
  private sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: any; auth?: AuthIdentity }>();
  private metrics: ServerMetrics;
  private isOwner = false;
  private sampleFallback?: SampleHandler;
  private listRootsFallback?: ListRootsHandler;
  private rootsListChangedListeners: Array<(roots?: Root[]) => void> = [];

  constructor(config: McpServerConfigInput<TContext>) {
    this.config = resolveConfig(config);
    const raw = typeof config === 'string' ? { name: config } : config;
    if (typeof raw === 'object' && raw !== null) {
      if (raw.onSample) {
        this.sampleFallback = raw.onSample;
      }
      if (raw.onListRoots) {
        this.listRootsFallback = raw.onListRoots;
      }
    }
    this.logger = (raw.logger as DefaultLogger) || new DefaultLogger({
      logDir: this.config.logDir,
      level: this.config.logLevel,
      retentionDays: this.config.retentionDays,
      logToStderr: this.config.logToStderr
    });

    this.contextManager = new ContextManager(raw.context);
    this.toolRegistry = new ToolRegistry<TContext>({
      defaultCoerceInputs: this.config.coerceInputs
    });
    this.middlewareManager = new MiddlewareManager<TContext>(raw.middleware);
    this.instanceCoordinator = new InstanceCoordinator(this.config);
    this.stateManager = new StateManager(this.config.dataDir);
    this.lockManager = new LockManager(this.config.dataDir);

    this.metrics = {
      startedAt: new Date().toISOString(),
      activeSessions: 0,
      totalSessions: 0
    };

    // Register built-in system resources
    this.resourceRegistry.register({
      uri: 'system://analytics',
      name: 'Server Analytics',
      description: 'Real-time tool execution metrics and inter-tool call graph',
      mimeType: 'application/json',
      handler: () => {
        return {
          contents: [
            {
              uri: 'system://analytics',
              mimeType: 'application/json',
              text: JSON.stringify(this.analytics.getSnapshot(), null, 2)
            }
          ]
        };
      }
    });

    this.resourceRegistry.register({
      uri: 'system://metrics',
      name: 'Prometheus Metrics',
      description: 'Standard Prometheus text exposition metrics for scraping',
      mimeType: 'text/plain; version=0.0.4; charset=utf-8',
      handler: () => {
        return {
          contents: [
            {
              uri: 'system://metrics',
              mimeType: 'text/plain; version=0.0.4; charset=utf-8',
              text: this.getMetrics()
            }
          ]
        };
      }
    });

    // Register initial tools if provided
    if (raw.tools) {
      for (const t of raw.tools) {
        this.tool(t);
      }
    }
  }

  /**
   * Registers a global tool middleware that intercepts all tool executions.
   */
  use(handler: ToolMiddlewareHandler<TContext>): this;
  /**
   * Registers a filtered tool middleware that intercepts matching tools.
   */
  use(filter: MiddlewareFilter, handler: ToolMiddlewareHandler<TContext>): this;
  use(
    filterOrHandler: MiddlewareFilter | ToolMiddlewareHandler<TContext>,
    maybeHandler?: ToolMiddlewareHandler<TContext>
  ): this {
    if (typeof filterOrHandler === 'function') {
      this.middlewareManager.use(filterOrHandler);
    } else {
      this.middlewareManager.use(filterOrHandler, maybeHandler!);
    }
    return this;
  }

  /**
   * Registers a tool using a definition object or positional arguments.
   */
  tool<TInput = any>(definition: ToolDefinition<TInput, TContext>): this;
  tool<TInput = any>(
    name: string,
    handler: ToolDefinition<TInput, TContext>['handler']
  ): this;
  tool<TInput = any>(
    name: string,
    inputSchema: InputSchemaDefinition | ShorthandInputSchema,
    handler: ToolDefinition<TInput, TContext>['handler']
  ): this;
  tool<TInput = any>(
    name: string,
    description: string,
    inputSchema: InputSchemaDefinition | ShorthandInputSchema,
    handler: ToolDefinition<TInput, TContext>['handler']
  ): this;
  tool(
    nameOrDef: string | ToolDefinition<any, TContext>,
    descOrSchemaOrHandler?: string | InputSchemaDefinition | ShorthandInputSchema | ToolDefinition<any, TContext>['handler'],
    schemaOrHandler?: InputSchemaDefinition | ShorthandInputSchema | ToolDefinition<any, TContext>['handler'],
    maybeHandler?: ToolDefinition<any, TContext>['handler']
  ): this {
    if (typeof nameOrDef === 'object' && nameOrDef !== null) {
      this.toolRegistry.register(nameOrDef);
      return this;
    }

    const name = nameOrDef;
    let description: string | undefined;
    let inputSchema: InputSchemaDefinition | ShorthandInputSchema | undefined;
    let handler: ToolDefinition<any, TContext>['handler'];

    if (typeof descOrSchemaOrHandler === 'function') {
      handler = descOrSchemaOrHandler;
    } else if (typeof descOrSchemaOrHandler === 'string') {
      description = descOrSchemaOrHandler;
      if (typeof schemaOrHandler === 'function') {
        handler = schemaOrHandler;
      } else {
        inputSchema = schemaOrHandler as InputSchemaDefinition | ShorthandInputSchema;
        handler = maybeHandler!;
      }
    } else {
      inputSchema = descOrSchemaOrHandler as InputSchemaDefinition | ShorthandInputSchema;
      handler = schemaOrHandler as ToolDefinition<any, TContext>['handler'];
    }

    this.toolRegistry.register({
      name,
      description,
      inputSchema: inputSchema as InputSchemaDefinition,
      handler
    });
    return this;
  }

  /**
   * Automatically parses an OpenAPI v3 or Swagger v2 specification and registers all operations as MCP tools.
   * Accepts an object, JSON string, file path, or remote URL.
   */
  async fromOpenApi(
    spec: Record<string, any> | string,
    options?: OpenApiOptions
  ): Promise<ToolDefinition[]> {
    const tools = await createOpenApiTools(spec, options);
    for (const t of tools) {
      this.tool(t);
    }
    return tools;
  }

  /**
   * Returns all registered tools.
   */
  getTools(): RegisteredTool<TContext>[] {
    return this.toolRegistry.getAll();
  }

  /**
   * Returns a specific registered tool by name.
   */
  getTool(name: string): RegisteredTool<TContext> | undefined {
    return this.toolRegistry.get(name);
  }

  /**
   * Invokes a registered tool programmatically by name.
   * Can be called from outside the server or from inside other tools.
   * Includes parameter validation, cycle/recursion detection, timeouts, cancellation, and result auto-normalization.
   */
  async callTool<TResult = any>(
    name: string,
    args: Record<string, any> = {},
    optionsOrStack?: CallOptions | string[],
    internalStack?: string[]
  ): Promise<ToolCallResult<TResult>> {
    const options: CallOptions =
      optionsOrStack && !Array.isArray(optionsOrStack) ? optionsOrStack : {};
    const callStack: string[] = Array.isArray(optionsOrStack)
      ? optionsOrStack
      : (Array.isArray(internalStack) ? internalStack : []);

    if (!name || typeof name !== 'string') {
      throw new Error('Tool name must be a non-empty string');
    }

    if (callStack.includes(name)) {
      throw new Error(
        `Circular tool invocation detected: ${[...callStack, name].join(' -> ')}`
      );
    }

    if (callStack.length >= 20) {
      throw new Error(
        `Maximum tool call depth exceeded (20): ${[...callStack, name].join(' -> ')}`
      );
    }

    const tool = this.toolRegistry.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    if (tool.requireAuth && !options.auth) {
      throw new Error(`Authentication required for tool "${name}"`);
    }

    if (tool.scopes && tool.scopes.length > 0) {
      if (!verifyToolScopes(tool.scopes, options.auth?.scopes)) {
        throw new Error(
          `Forbidden: Tool "${name}" requires scopes: ${tool.scopes.join(', ')}`
        );
      }
    }

    const start = Date.now();
    let validatedArgs = args || {};

    if (tool.normalizedSchema && Object.keys(tool.normalizedSchema).length > 0) {
      const effectiveCoerce =
        options.coerceInputs !== undefined
          ? options.coerceInputs
          : (tool.coerceInputs !== undefined ? tool.coerceInputs : this.config.coerceInputs);

      let argsToParse = validatedArgs;
      if (effectiveCoerce) {
        argsToParse = coerceArguments(validatedArgs, tool.inputSchema as any);
      }

      const schema = effectiveCoerce
        ? (tool.compiledCoerceSchema || tool.compiledSchema)
        : tool.compiledSchema;

      if (schema) {
        const parsed = schema.safeParse(argsToParse);
        if (!parsed.success) {
          const errorDetails = parsed.error.issues
            .map((i: any) => `${i.path.join('.') || 'input'}: ${i.message}`)
            .join(', ');
          throw new Error(`Validation failed for tool "${name}": ${errorDetails}`);
        }
        validatedArgs = parsed.data;
      } else {
        const activeSchema = effectiveCoerce
          ? tool.normalizedSchema
          : normalizeInputSchema(tool.inputSchema, tool.name, { coerceInputs: false });
        const fallbackSchema = z.object(activeSchema);
        const parsed = fallbackSchema.safeParse(argsToParse);
        if (!parsed.success) {
          const errorDetails = parsed.error.issues
            .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
            .join(', ');
          throw new Error(`Validation failed for tool "${name}": ${errorDetails}`);
        }
        validatedArgs = parsed.data;
      }
    }

    // Early cache lookup: return immediately before allocating AbortControllers, timers, closures
    const cacheConfig = typeof tool.cache === 'object' ? tool.cache : (tool.cache ? {} : undefined);
    const bypassCache = options.noCache === true || options.bypassCache === true;

    if (cacheConfig && !bypassCache) {
      const cached = this.cacheManager.get(name, validatedArgs, cacheConfig);
      if (cached) {
        const durationMs = Date.now() - start;
        const caller = callStack.length > 0 ? callStack[callStack.length - 1] : undefined;
        this.analytics.recordInvocation({
          tool: tool.name,
          caller,
          durationMs,
          status: 'success',
          isCacheHit: true
        });
        this.metrics.lastToolInvocation = {
          name: tool.name,
          timestamp: new Date().toISOString()
        };
        this.logger.info('tool:cache_hit', { name: tool.name, durationMs });
        return cached as ToolCallResult<TResult>;
      }
    }

    const effectiveTimeout =
      options.timeoutMs !== undefined
        ? options.timeoutMs
        : (tool.timeoutMs !== undefined ? tool.timeoutMs : this.config.toolTimeoutMs);

    const timeoutController = effectiveTimeout > 0 ? new AbortController() : null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (effectiveTimeout > 0 && timeoutController) {
      timeoutTimer = setTimeout(() => {
        timeoutController.abort(
          new Error(`Tool "${tool.name}" execution timed out after ${effectiveTimeout}ms`)
        );
      }, effectiveTimeout);
    }

    const signals: AbortSignal[] = [];
    if (options.signal) {
      signals.push(options.signal);
    }
    if (timeoutController) {
      signals.push(timeoutController.signal);
    }

    const mergedSignal =
      signals.length > 1
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0])
        : signals[0];

    const currentStack = [...callStack, name];
    const callToolHelper = <T = any>(
      targetName: string,
      targetArgs: Record<string, any> = {},
      targetOptions?: CallOptions
    ) => {
      const mergedOptions: CallOptions = {
        signal: targetOptions?.signal || mergedSignal,
        timeoutMs: targetOptions?.timeoutMs,
        throwOnError: targetOptions?.throwOnError,
        noCache: targetOptions?.noCache,
        bypassCache: targetOptions?.bypassCache,
        retry: targetOptions?.retry,
        coerceInputs: targetOptions?.coerceInputs,
        onProgress: targetOptions?.onProgress,
        progressToken: targetOptions?.progressToken,
        auth: targetOptions?.auth || options.auth
      };
      return this.callTool<T>(targetName, targetArgs, mergedOptions, currentStack);
    };

    const clearCacheHelper = (targetToolName?: string) => {
      return this.clearCache(targetToolName);
    };

    const reportProgress = createProgressReporter({
      toolName: tool.name,
      progressToken: options.progressToken,
      onProgress: options.onProgress,
      logger: this.logger
    });

    const activeSession = this.sessions.size > 0 ? Array.from(this.sessions.values())[this.sessions.size - 1] : undefined;
    const sessionServer = activeSession?.server;

    const sampleHelper = (input: string | SampleOptions, opts?: Partial<SampleOptions>) => {
      return executeSample(input, opts, sessionServer, this.sampleFallback, mergedSignal);
    };

    const listRootsHelper = () => {
      return executeListRoots(sessionServer, this.listRootsFallback, mergedSignal);
    };

    const extra: ToolExtra = {
      signal: mergedSignal,
      callTool: callToolHelper,
      clearCache: clearCacheHelper,
      reportProgress,
      progressToken: options.progressToken,
      sample: sampleHelper,
      listRoots: listRootsHelper,
      auth: options.auth
    };

    const queueConfig = this.resolveQueueConfig(tool, options, callStack.length > 0);
    let release: (() => void) | undefined;
    let retriesCount = 0;

    try {
      if (queueConfig) {
        release = await this.queueManager
          .getQueue(queueConfig.key, queueConfig.maxConcurrency)
          .acquire(mergedSignal);
      }

      if (!this.contextManager.isInitialized()) {
        await this.contextManager.initialize(this.logger);
      }
      const ctx = this.contextManager.getContext();

      const handlerCtx =
        ctx && typeof ctx === 'object'
          ? Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, {
              callTool: callToolHelper,
              signal: mergedSignal,
              clearCache: clearCacheHelper,
              reportProgress,
              sample: sampleHelper,
              listRoots: listRootsHelper,
              auth: options.auth
            })
          : {
              callTool: callToolHelper,
              signal: mergedSignal,
              clearCache: clearCacheHelper,
              reportProgress,
              sample: sampleHelper,
              listRoots: listRootsHelper,
              auth: options.auth
            };

      this.logger.info('tool:start', { name: tool.name, caller: callStack[callStack.length - 1] });

      const effectiveRetry = options.retry !== undefined ? options.retry : tool.retry;

      const middlewarePipeline = this.middlewareManager.composeForTool(
        tool.name,
        (pCtx) => Promise.resolve(tool.handler(pCtx.args, pCtx.context, pCtx.extra)),
        tool.middleware
      );

      const runAttempt = () => {
        const middlewareCtx: ToolMiddlewareContext<TContext> = {
          tool: tool.name,
          args: validatedArgs,
          context: handlerCtx,
          extra,
          options,
          callStack
        };
        const executionPromise = middlewarePipeline(middlewareCtx);
        return raceWithSignal(
          executionPromise,
          mergedSignal,
          () => new Error(`Tool "${tool.name}" execution was cancelled`)
        );
      };

      const { result: rawResult, retries } = await executeWithRetry(
        runAttempt,
        {
          name: tool.name,
          config: effectiveRetry,
          signal: mergedSignal,
          onRetry: (err, attempt, delayMs) => {
            retriesCount = attempt;
            this.logger.warn('tool:retry', {
              name: tool.name,
              attempt,
              delayMs,
              error: err?.message || String(err)
            });
          }
        }
      );
      retriesCount = retries;

      const durationMs = Date.now() - start;
      const caller = callStack.length > 0 ? callStack[callStack.length - 1] : undefined;
      this.analytics.recordInvocation({
        tool: tool.name,
        caller,
        durationMs,
        status: 'success',
        retries: retriesCount
      });
      this.metrics.lastToolInvocation = {
        name: tool.name,
        timestamp: new Date().toISOString()
      };

      this.logger.info('tool:end', { name: tool.name, durationMs });
      const normalized = normalizeToolResult<TResult>(rawResult);
      if (cacheConfig && !bypassCache && !normalized.isError) {
        this.cacheManager.set(name, validatedArgs, normalized, cacheConfig);
      }
      return normalized;
    } catch (error: any) {
      const durationMs = Date.now() - start;
      const isTimeout = String(error?.message || error).includes('timed out');
      const isCancelled = Boolean(mergedSignal?.aborted && !isTimeout);
      const status: ToolInvocationStatus = isTimeout ? 'timeout' : (isCancelled ? 'cancelled' : 'error');
      const caller = callStack.length > 0 ? callStack[callStack.length - 1] : undefined;

      this.analytics.recordInvocation({
        tool: tool.name,
        caller,
        durationMs,
        status,
        errorMessage: error.message || String(error),
        retries: retriesCount || (error?.retries ?? 0)
      });
      this.metrics.lastToolInvocation = {
        name: tool.name,
        timestamp: new Date().toISOString()
      };

      this.logger.error('tool:error', {
        name: tool.name,
        durationMs,
        isTimeout,
        isCancelled,
        error: error.message || String(error),
        stack: error.stack
      });

      if (options.throwOnError !== false) {
        throw error;
      }

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error in tool "${tool.name}": ${error.message || String(error)}`
          }
        ],
        data: undefined as unknown as TResult,
        text: `Error in tool "${tool.name}": ${error.message || String(error)}`
      };
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      release?.();
    }
  }

  /**
   * Resolves the queue key and maxConcurrency for a tool invocation.
   * Returns null if no concurrency limiting is requested.
   */
  resolveQueueConfig(
    tool: ToolDefinition<any, TContext>,
    options?: CallOptions,
    isChildCall = false
  ): { key: string; maxConcurrency: number } | null {
    const callSequential = options?.sequential;
    if (callSequential === true) {
      return { key: `tool:${tool.name}`, maxConcurrency: 1 };
    }
    if (typeof callSequential === 'string') {
      return { key: `mutex:${callSequential}`, maxConcurrency: 1 };
    }

    if (tool.sequential === true) {
      return { key: `tool:${tool.name}`, maxConcurrency: 1 };
    }
    if (typeof tool.sequential === 'string') {
      return { key: `mutex:${tool.sequential}`, maxConcurrency: 1 };
    }
    if (tool.maxConcurrency !== undefined && tool.maxConcurrency > 0) {
      return { key: `tool:${tool.name}`, maxConcurrency: tool.maxConcurrency };
    }

    if (this.config.sequential || (this.config.maxConcurrency && this.config.maxConcurrency > 0)) {
      if (isChildCall) {
        return null;
      }
      return {
        key: '__server_global__',
        maxConcurrency: this.config.maxConcurrency || 1
      };
    }

    return null;
  }

  /**
   * Returns current concurrency queue statistics.
   */
  getQueueStats() {
    return this.queueManager.getStats();
  }

  /**
   * Clears in-memory cache entries.
   * If toolName is provided, clears only that tool's cached responses.
   * If omitted, clears all cached responses across all tools.
   * Returns the count of evicted entries.
   */
  clearCache(toolName?: string): number {
    return this.cacheManager.clear(toolName);
  }

  /**
   * Returns current cache statistics (size, hits, misses, evictions).
   */
  getCacheStats(): CacheStats {
    return this.cacheManager.getStats();
  }

  /**
   * Returns a complete snapshot of tool analytics, execution times, and inter-tool relationships.
   */
  getAnalytics(): ServerAnalytics {
    return this.analytics.getSnapshot();
  }

  /**
   * Returns standard Prometheus-formatted metrics text (exposition format 0.0.4) for scraping.
   */
  getMetrics(): string {
    const uptimeSeconds = (Date.now() - new Date(this.metrics.startedAt).getTime()) / 1000;
    return this.analytics.toPrometheusFormat({
      serverName: this.config.name,
      version: this.config.version,
      activeSessions: this.metrics.activeSessions,
      totalSessions: this.metrics.totalSessions,
      uptimeSeconds: Math.max(0, uptimeSeconds),
      cacheStats: this.cacheManager.getStats()
    });
  }

  /**
   * Resets all recorded analytics counters and history.
   */
  resetAnalytics(): void {
    this.analytics.reset();
  }

  /**
   * Registers a dynamic RFC 6570 resource template.
   */
  resourceTemplate(definition: ResourceTemplateDefinition<TContext>): this {
    this.resourceRegistry.registerTemplate(definition);
    return this;
  }

  /**
   * Registers a static resource or dynamic resource template.
   * If definition contains `uriTemplate` or its `uri` contains template variables `{...}`,
   * it will automatically be registered as a dynamic resource template.
   */
  resource(definition: AnyResourceDefinition<TContext>): this {
    if (
      'uriTemplate' in definition &&
      typeof (definition as ResourceTemplateDefinition<TContext>).uriTemplate === 'string'
    ) {
      this.resourceRegistry.registerTemplate(definition as ResourceTemplateDefinition<TContext>);
      return this;
    }

    const staticDef = definition as ResourceDefinition<TContext>;
    if (staticDef.uri && staticDef.uri.includes('{') && staticDef.uri.includes('}')) {
      const templateDef: ResourceTemplateDefinition<TContext> = {
        uriTemplate: staticDef.uri,
        name: staticDef.name,
        description: staticDef.description,
        mimeType: staticDef.mimeType,
        handler: (uri, params, ctx) => (staticDef.handler as any)(uri, params, ctx)
      };
      this.resourceRegistry.registerTemplate(templateDef);
      return this;
    }

    this.resourceRegistry.register(staticDef);
    return this;
  }

  /**
   * Registers a prompt.
   */
  prompt<TArgs = any>(definition: PromptDefinition<TArgs, TContext>): this {
    this.promptRegistry.register(definition);
    return this;
  }

  /**
   * Retrieves a registered static resource definition by URI.
   */
  getResource(uri: string): ResourceDefinition<TContext> | undefined {
    return this.resourceRegistry.get(uri);
  }

  /**
   * Retrieves all registered static resource definitions.
   */
  getResources(): ResourceDefinition<TContext>[] {
    return this.resourceRegistry.getAll();
  }

  /**
   * Retrieves a registered resource template definition by URI template string or name.
   */
  getResourceTemplate(nameOrUriTemplate: string): ResourceTemplateDefinition<TContext> | undefined {
    return this.resourceRegistry.getTemplate(nameOrUriTemplate);
  }

  /**
   * Retrieves all registered resource template definitions.
   */
  getResourceTemplates(): ResourceTemplateDefinition<TContext>[] {
    return this.resourceRegistry.getAllTemplates();
  }

  /**
   * Matches a concrete URI against registered resource templates and returns extracted variables.
   */
  matchResourceTemplate(uri: string): ResourceMatchResult<TContext> | undefined {
    return this.resourceRegistry.findMatchingTemplate(uri);
  }

  /**
   * Programmatically reads a resource by static URI or template match.
   * Useful for testing, inter-service reads, and direct execution without an MCP client.
   */
  async readResource(uri: string | URL, context?: TContext): Promise<ReadResourceResult> {
    const uriString = typeof uri === 'string' ? uri : uri.href;
    let urlObj: URL;
    try {
      urlObj = typeof uri === 'string' ? new URL(uri) : uri;
    } catch {
      urlObj = new URL(`resource:///${String(uri).replace(/^\/+/, '')}`);
    }

    let ctx: TContext;
    if (context !== undefined) {
      ctx = context;
    } else {
      if (!this.contextManager.isInitialized()) {
        await this.contextManager.initialize(this.logger);
      }
      ctx = this.contextManager.getContext();
    }

    // 1. Check static resources first
    const staticRes = this.resourceRegistry.get(uriString) || this.resourceRegistry.get(urlObj.href);
    if (staticRes) {
      const raw = await staticRes.handler(urlObj, ctx);
      return normalizeResourceResult(raw, urlObj, staticRes.mimeType);
    }

    // 2. Check dynamic resource templates
    const match =
      this.resourceRegistry.findMatchingTemplate(uriString) ||
      this.resourceRegistry.findMatchingTemplate(urlObj.href);
    if (match) {
      const raw = await match.template.handler(urlObj, match.params, ctx);
      return normalizeResourceResult(raw, urlObj, match.template.mimeType);
    }

    throw new Error(`Resource not found: "${uriString}"`);
  }

  /**
   * Notifies connected MCP clients subscribed to a resource URI that its contents have changed.
   * Sends `notifications/resources/updated` with the updated URI.
   * Returns the count of client sessions successfully notified.
   */
  async notifyResourceUpdated(uri: string | URL): Promise<number> {
    const uriString = typeof uri === 'string' ? uri : uri.href;
    let notifiedCount = 0;

    const subscriberSessions = new Set(this.subscriptionRegistry.getSubscribers(uriString));

    for (const [sessionId, session] of this.sessions.entries()) {
      const isSubscribed =
        subscriberSessions.has(sessionId) ||
        this.subscriptionRegistry.isSubscribed(sessionId, uriString) ||
        subscriberSessions.size === 0;

      if (isSubscribed && session.server?.server) {
        try {
          await session.server.server.sendResourceUpdated({ uri: uriString });
          notifiedCount++;
        } catch (err: any) {
          this.logger.debug('Failed to send resource updated notification to session', {
            session: sessionId,
            uri: uriString,
            error: err.message
          });
        }
      }
    }

    // Trigger local server-side listeners
    for (const listener of this.resourceUpdateListeners) {
      try {
        listener(uriString);
      } catch (err: any) {
        this.logger.error('Error in resource update listener', {
          uri: uriString,
          error: err.message
        });
      }
    }

    return notifiedCount;
  }

  /**
   * Notifies connected MCP clients that the list of available resources has changed.
   * Sends `notifications/resources/list_changed`.
   * Returns the count of client sessions successfully notified.
   */
  async notifyResourceListChanged(): Promise<number> {
    let notifiedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.server?.server) {
        try {
          await session.server.server.sendResourceListChanged();
          notifiedCount++;
        } catch (err: any) {
          this.logger.debug('Failed to send resource list changed notification to session', {
            session: sessionId,
            error: err.message
          });
        }
      }
    }

    return notifiedCount;
  }

  /**
   * Subscribes a local event listener to resource update notifications.
   * Returns an unsubscribe function.
   */
  onResourceUpdated(listener: (uri: string) => void): () => void {
    this.resourceUpdateListeners.add(listener);
    return () => {
      this.resourceUpdateListeners.delete(listener);
    };
  }

  /**
   * Returns all active subscribed resource URIs across all sessions or for a specific session.
   */
  getSubscribedResources(sessionId?: string): string[] {
    if (sessionId) {
      return this.subscriptionRegistry.getSubscriptions(sessionId);
    }
    return this.subscriptionRegistry.getAllSubscribedUris();
  }

  /**
   * Requests LLM completion/sampling back from the connected client via MCP sampling/createMessage.
   * If running offline or in tests, delegates to any fallback handler configured with app.onSample().
   */
  async sample(input: string | SampleOptions, options?: Partial<SampleOptions>): Promise<SampleResult> {
    const activeSession = this.sessions.size > 0 ? Array.from(this.sessions.values())[this.sessions.size - 1] : undefined;
    const sessionServer = activeSession?.server;
    return executeSample(input, options, sessionServer, this.sampleFallback);
  }

  /**
   * Requests the list of root workspace directories from the connected client via MCP roots/list.
   */
  async listRoots(): Promise<Root[]> {
    const activeSession = this.sessions.size > 0 ? Array.from(this.sessions.values())[this.sessions.size - 1] : undefined;
    const sessionServer = activeSession?.server;
    return executeListRoots(sessionServer, this.listRootsFallback);
  }

  /**
   * Registers a fallback/offline handler for sampling requests.
   */
  onSample(handler: SampleHandler): this {
    this.sampleFallback = handler;
    return this;
  }

  /**
   * Registers a fallback/offline handler for workspace roots requests.
   */
  onListRoots(handler: ListRootsHandler): this {
    this.listRootsFallback = handler;
    return this;
  }

  /**
   * Listens for client roots/list_changed notifications.
   * Returns an unbind function.
   */
  onRootsListChanged(listener: (roots?: Root[]) => void): () => void {
    this.rootsListChangedListeners.push(listener);
    return () => {
      const idx = this.rootsListChangedListeners.indexOf(listener);
      if (idx !== -1) {
        this.rootsListChangedListeners.splice(idx, 1);
      }
    };
  }

  /**
   * Resolves argument autocompletions for prompts, resource templates, or tools.
   */
  async complete(
    ref: { type: 'ref/prompt' | 'ref/resource' | 'ref/tool' | string; name?: string; uri?: string },
    argument: { name: string; value: string }
  ): Promise<CompletionResult> {
    return resolveCompletion({
      promptRegistry: this.promptRegistry,
      resourceRegistry: this.resourceRegistry,
      toolRegistry: this.toolRegistry,
      ref,
      argument,
      context: this.contextManager.isInitialized() ? this.contextManager.getContext() : undefined
    });
  }

  /**
   * Returns the HTTP URL of the interactive Web Inspector for this server.
   */
  getInspectorUrl(host?: string): string {
    const targetHost = host || this.httpHandle?.host || this.config.host || 'localhost';
    const port = this.httpHandle?.port || this.config.port || 3000;
    return `http://${targetHost}:${port}/inspect`;
  }

  /**
   * Retrieves a registered prompt definition by name.
   */
  getPrompt(name: string): PromptDefinition<any, TContext> | undefined {
    return this.promptRegistry.get(name);
  }

  /**
   * Returns the directory where log files are stored.
   */
  async getLogDirectory(): Promise<string> {
    return this.config.logDir;
  }

  /**
   * Reads recent log entries.
   */
  async readLogs(limit = 100): Promise<string[]> {
    return this.logger.readLogs(limit);
  }

  /**
   * Returns the current status of the server.
   */
  async status(): Promise<ServerStatus> {
    const state = this.stateManager.read();
    if (!state || state.name !== this.config.name) {
      return {
        status: 'stopped',
        dataDir: this.config.dataDir,
        logDir: this.config.logDir
      };
    }

    const health = await checkHealth(state.host, state.port, this.config.name, 1000);
    if (!health) {
      return {
        status: 'stopped',
        dataDir: this.config.dataDir,
        logDir: this.config.logDir
      };
    }

    const info = await fetchInfo(state.host, state.port, 1000);

    return {
      status: 'running',
      role: this.isOwner ? 'owner' : 'bridge',
      pid: state.pid,
      port: state.port,
      host: state.host,
      startedAt: state.startedAt,
      dataDir: this.config.dataDir,
      logDir: this.config.logDir,
      activeSessions: info?.activeSessions ?? this.metrics.activeSessions,
      totalSessions: info?.totalSessions ?? this.metrics.totalSessions
    };
  }

  /**
   * Starts the server programmatically. If a server is already running,
   * reuses it and returns `{ reused: true, ... }`.
   */
  async start(options: StartOptions = {}): Promise<StartResult> {
    const isBackgroundWorker =
      process.env.MCPONCE_BACKGROUND_SERVER === '1' ||
      process.argv.includes('--mcponce-background');

    const shouldRunBackground =
      options.background !== undefined ? options.background : this.config.background;

    if (shouldRunBackground && !isBackgroundWorker && !options.noSingleton) {
      await getUnitup();

      const existingState = this.stateManager.read();
      if (existingState && existingState.name === this.config.name) {
        const health = await checkHealth(existingState.host, existingState.port, this.config.name, 1000);
        if (health) {
          return {
            reused: true,
            role: 'bridge',
            pid: existingState.pid,
            port: existingState.port,
            host: existingState.host
          };
        }
      }

      const initialLock = this.lockManager.readLock();
      if (!initialLock || !isPidRunning(initialLock.pid)) {
        this.lockManager.forceRelease();
        this.stateManager.forceClean();
      }

      if (this.lockManager.tryAcquire(this.config.name)) {
        try {
          await startBackgroundProcess({
            name: this.config.name,
            scriptPath: this.config.entrypoint,
            dataDir: this.config.dataDir,
            logDir: this.config.logDir
          });
        } finally {
          this.lockManager.release();
        }
      }

      const maxWaitMs = 20000;
      const startTime = Date.now();
      let healthyState: any = null;
      while (Date.now() - startTime < maxWaitMs) {
        await new Promise((r) => setTimeout(r, 25));
        const st = this.stateManager.read();
        if (st && st.name === this.config.name) {
          const h = await checkHealth(st.host, st.port, this.config.name, 300);
          if (h) {
            healthyState = st;
            break;
          }
        }
      }

      if (!healthyState) {
        throw new Error(
          `Failed to start background MCP server for "${this.config.name}" through Unitup: health check timed out`
        );
      }

      return {
        reused: false,
        role: 'owner',
        pid: healthyState.pid,
        port: healthyState.port,
        host: healthyState.host
      };
    }

    const roleResult = await this.instanceCoordinator.ensureInstance({
      noSingleton: options.noSingleton,
      logger: this.logger
    });

    if (roleResult.role === 'bridge') {
      return {
        reused: true,
        role: 'bridge',
        pid: roleResult.state.pid,
        port: roleResult.state.port,
        host: roleResult.state.host
      };
    }

    // Role is owner: initialize context and start HTTP server
    this.isOwner = true;
    await this.contextManager.initialize(this.logger);

    let currentPort = this.config.port;
    const honoApp = createHonoApp({
      config: this.config,
      toolRegistry: this.toolRegistry,
      resourceRegistry: this.resourceRegistry,
      promptRegistry: this.promptRegistry,
      contextManager: this.contextManager,
      metrics: this.metrics,
      analytics: this.analytics,
      portProvider: () => currentPort,
      callTool: (name, args, options, stack) => this.callTool(name, args, options, stack),
      logger: this.logger,
      queueManager: this.queueManager,
      cacheManager: this.cacheManager,
      middlewareManager: this.middlewareManager,
      resolveQueueConfig: (tool, opts) => this.resolveQueueConfig(tool, opts),
      sessions: this.sessions,
      subscriptionRegistry: this.subscriptionRegistry,
      onSample: this.sampleFallback,
      onListRoots: this.listRootsFallback,
      onRootsListChanged: (roots) => {
        for (const listener of this.rootsListChangedListeners) {
          listener(roots);
        }
      }
    });

    this.httpHandle = await startHttpServer(honoApp, this.config.host, this.config.port);
    currentPort = this.httpHandle.port;

    this.stateManager.write({
      name: this.config.name,
      version: this.config.version,
      pid: process.pid,
      port: this.httpHandle.port,
      host: this.httpHandle.host,
      startedAt: this.metrics.startedAt
    });

    if (this.config.registerInCentral) {
      try {
        await this.centralRegistry.register({
          name: this.config.name,
          version: this.config.version,
          status: 'running',
          pid: process.pid,
          port: this.httpHandle.port,
          host: this.httpHandle.host,
          dataDir: this.config.dataDir,
          logDir: this.config.logDir,
          startedAt: this.metrics.startedAt
        });
      } catch {}
    }

    this.logger.info('server:start', {
      pid: process.pid,
      port: this.httpHandle.port,
      host: this.httpHandle.host
    });

    return {
      reused: false,
      role: 'owner',
      pid: process.pid,
      port: this.httpHandle.port,
      host: this.httpHandle.host
    };
  }

  /**
   * Stops the server if running as owner, or shuts down the running instance.
   */
  async stop(options: StopOptions = {}): Promise<void> {
    if (this.stdioProxyHandle) {
      await this.stdioProxyHandle.close();
      this.stdioProxyHandle = undefined;
    }

    if (this.httpHandle) {
      await this.httpHandle.close();
      this.httpHandle = undefined;
    }

    const shouldStopBackground =
      options.background !== undefined ? options.background : this.config.background;

    if (shouldStopBackground) {
      try {
        await stopBackgroundProcess(this.config.name);
      } catch {}
      if (this.config.registerInCentral) {
        try {
          await this.centralRegistry.updateStatus(this.config.name, 'stopped');
        } catch {}
      }
      this.stateManager.forceClean();
      this.lockManager.forceRelease();
      this.isOwner = false;
      return;
    }

    if (this.isOwner) {
      if (this.config.registerInCentral) {
        try {
          await this.centralRegistry.updateStatus(this.config.name, 'stopped');
        } catch {}
      }
      this.stateManager.clean();
      this.lockManager.release();
      this.isOwner = false;
    } else {
      // If we are not owner in this process, check if an instance is running and signal it
      const state = this.stateManager.read();
      if (state && state.name === this.config.name && isPidRunning(state.pid)) {
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {}
      }
    }
  }

  /**
   * Restarts the server. If running in background mode, restarts the Unitup process
   * and waits for /health.
   */
  async restart(options: RestartOptions = {}): Promise<StartResult> {
    await this.stop(options);
    await new Promise((r) => setTimeout(r, 200));
    return await this.start(options);
  }

  /**
   * Primary entry point for running the executable.
   * Handles CLI commands (info, logs, --dev, etc.) and runs the automatic
   * single-instance MCP server and stdio bridge.
   */
  async run(): Promise<void> {
    const cliOptions = await handleCliArgs(process.argv.slice(2), this.config, this);
    if (cliOptions.isCliCommand) {
      return;
    }

    if (cliOptions.devMode) {
      this.logger.setLogToStderr(true);
      try {
        process.stderr.write(
          `[${this.config.name}] Starting in development mode (pid: ${process.pid})...\n`
        );
      } catch {}
    }

    const isBackgroundWorker =
      process.env.MCPONCE_BACKGROUND_SERVER === '1' ||
      process.argv.includes('--mcponce-background');

    if (isBackgroundWorker) {
      const startResult = await this.start({ noSingleton: false });

      this.logger.info('Background MCP worker running', {
        name: this.config.name,
        pid: process.pid,
        port: startResult.port,
        host: startResult.host
      });

      const shutdown = async () => {
        await this.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.on('SIGHUP', shutdown);

      return;
    }

    const backgroundMode = this.config.background || cliOptions.background;

    if (backgroundMode) {
      await getUnitup();

      let targetPort: number;
      let targetHost: string;
      let serverPid: number;

      const existingState = this.stateManager.read();
      const isHealthy =
        existingState && existingState.name === this.config.name
          ? await checkHealth(existingState.host, existingState.port, this.config.name, 1000)
          : null;

      if (isHealthy && existingState) {
        targetPort = existingState.port;
        targetHost = existingState.host;
        serverPid = existingState.pid;
      } else {
        if (existingState && !isHealthy) {
          this.lockManager.forceRelease();
          this.stateManager.forceClean();
        }

        if (this.lockManager.tryAcquire(this.config.name)) {
          try {
            await startBackgroundProcess({
              name: this.config.name,
              scriptPath: this.config.entrypoint,
              dataDir: this.config.dataDir,
              logDir: this.config.logDir
            });
          } finally {
            this.lockManager.release();
          }
        }

        const maxWaitMs = 20000;
        const start = Date.now();
        let healthyState: any = null;
        while (Date.now() - start < maxWaitMs) {
          await new Promise((r) => setTimeout(r, 25));
          const st = this.stateManager.read();
          if (st && st.name === this.config.name) {
            const h = await checkHealth(st.host, st.port, this.config.name, 300);
            if (h) {
              healthyState = st;
              break;
            }
          }
        }

        if (!healthyState) {
          throw new Error(
            `Failed to start background MCP server for "${this.config.name}" through Unitup: health check timed out`
          );
        }

        targetPort = healthyState.port;
        targetHost = healthyState.host;
        serverPid = healthyState.pid;
      }

      this.logger.info('bridge:start', {
        pid: process.pid,
        serverPid,
        port: targetPort
      });

      if (cliOptions.devMode) {
        try {
          process.stderr.write(
            `[${this.config.name}] Connected to background server on http://${targetHost}:${targetPort} (pid: ${serverPid})\n`
          );
        } catch {}
      }

      const mcpUrl = `http://${targetHost}:${targetPort}/mcp`;
      this.stdioProxyHandle = await startStdioProxy(mcpUrl, this.logger);
      await this.stdioProxyHandle.done;

      process.exit(0);
    }

    // Single-instance determination
    const roleResult = await this.instanceCoordinator.ensureInstance({
      noSingleton: cliOptions.noSingleton,
      logger: this.logger
    });

    let targetPort: number;
    let targetHost: string;

    let ownerStdioClosed = false;

    if (roleResult.role === 'owner') {
      this.isOwner = true;
      await this.contextManager.initialize(this.logger);

      let currentPort = this.config.port;
      const honoApp = createHonoApp({
        config: this.config,
        toolRegistry: this.toolRegistry,
        resourceRegistry: this.resourceRegistry,
        promptRegistry: this.promptRegistry,
        contextManager: this.contextManager,
        metrics: this.metrics,
        analytics: this.analytics,
        portProvider: () => currentPort,
        callTool: (name, args, options, stack) => this.callTool(name, args, options, stack),
        logger: this.logger,
        queueManager: this.queueManager,
        cacheManager: this.cacheManager,
        middlewareManager: this.middlewareManager,
        resolveQueueConfig: (tool, opts) => this.resolveQueueConfig(tool, opts),
        sessions: this.sessions,
        subscriptionRegistry: this.subscriptionRegistry,
        onSample: this.sampleFallback,
        onListRoots: this.listRootsFallback,
        onRootsListChanged: (roots) => {
          for (const listener of this.rootsListChangedListeners) {
            listener(roots);
          }
        },
        onSessionClosed: () => {
          if (ownerStdioClosed && this.sessions.size === 0) {
            this.logger.info('All sessions closed after owner stdio ended, shutting down', {
              pid: process.pid
            });
            shutdown();
          }
        }
      });

      this.httpHandle = await startHttpServer(honoApp, this.config.host, this.config.port);
      currentPort = this.httpHandle.port;
      targetPort = this.httpHandle.port;
      targetHost = this.httpHandle.host;

      this.stateManager.write({
        name: this.config.name,
        version: this.config.version,
        pid: process.pid,
        port: targetPort,
        host: targetHost,
        startedAt: this.metrics.startedAt
      });

      if (this.config.registerInCentral) {
        try {
          await this.centralRegistry.register({
            name: this.config.name,
            version: this.config.version,
            status: 'running',
            pid: process.pid,
            port: targetPort,
            host: targetHost,
            dataDir: this.config.dataDir,
            logDir: this.config.logDir,
            startedAt: this.metrics.startedAt
          });
        } catch {}
      }

      this.logger.info('server:start', {
        pid: process.pid,
        port: targetPort,
        host: targetHost
      });

      if (cliOptions.devMode) {
        try {
          process.stderr.write(
            `[${this.config.name}] Shared HTTP server listening on http://${targetHost}:${targetPort}\n`
          );
        } catch {}
      }
    } else {
      // Role is bridge
      targetPort = roleResult.state.port;
      targetHost = roleResult.state.host;

      this.logger.info('bridge:start', {
        pid: process.pid,
        serverPid: roleResult.state.pid,
        port: targetPort
      });

      if (cliOptions.devMode) {
        try {
          process.stderr.write(
            `[${this.config.name}] Connected to shared server on http://${targetHost}:${targetPort} (pid: ${roleResult.state.pid})\n`
          );
        } catch {}
      }
    }

    // Set up clean shutdown listeners
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;

      this.logger.info('server:shutdown', { pid: process.pid, isOwner: this.isOwner });

      if (this.stdioProxyHandle) {
        try {
          await this.stdioProxyHandle.close();
        } catch {}
      }

      if (this.isOwner) {
        if (this.config.registerInCentral) {
          try {
            await this.centralRegistry.updateStatus(this.config.name, 'stopped');
          } catch {}
        }
        if (this.httpHandle) {
          try {
            await this.httpHandle.close();
          } catch {}
        }
        this.stateManager.clean();
        this.lockManager.release();
      }

      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);
    process.on('exit', () => {
      if (this.isOwner && !shuttingDown) {
        if (this.config.registerInCentral) {
          try {
            this.centralRegistry.updateStatus(this.config.name, 'stopped');
          } catch {}
        }
        this.stateManager.clean();
        this.lockManager.release();
      }
    });

    // Start stdio proxy bridge to target local HTTP server
    const mcpUrl = `http://${targetHost}:${targetPort}/mcp`;
    this.stdioProxyHandle = await startStdioProxy(mcpUrl, this.logger);

    // Wait until stdio bridge completes (client closes stdin / disconnects)
    await this.stdioProxyHandle.done;

    // After this process's stdio bridge closes:
    if (this.isOwner) {
      ownerStdioClosed = true;
      // If we own the server, check if other sessions are still active
      if (this.sessions.size === 0) {
        this.logger.info('All sessions closed, owner shutting down', { pid: process.pid });
        await shutdown();
      } else {
        this.logger.info('Owner stdio closed, keeping HTTP server alive for active sessions', {
          activeSessions: this.sessions.size
        });
        // HTTP server continues running on Node event loop until other sessions finish
      }
    } else {
      // If we are just a bridge process, exit immediately
      process.exit(0);
    }
  }
}

/**
 * Creates an MCP server application.
 */
export function createMcpServer<TContext = unknown>(
  config: McpServerConfigInput<TContext>
): McpApp<TContext> {
  return new McpApp<TContext>(config);
}
