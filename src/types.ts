import type { z } from 'zod';
import type {
  CallToolResult,
  ReadResourceResult,
  GetPromptResult,
  Resource,
  ListResourcesResult,
  ImageContent,
  TextContent,
  EmbeddedResource
} from '@modelcontextprotocol/sdk/types.js';

import type {
  SamplingMessage,
  SampleOptions,
  NormalizedSampleParams,
  SampleResult,
  SampleHandler,
  Root,
  ListRootsHandler
} from './utils/sampling.js';

export type {
  ImageContent,
  TextContent,
  EmbeddedResource,
  Resource,
  ListResourcesResult,
  ReadResourceResult,
  CallToolResult,
  GetPromptResult,
  SamplingMessage,
  SampleOptions,
  NormalizedSampleParams,
  SampleResult,
  SampleHandler,
  Root,
  ListRootsHandler
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface LoggingConfig {
  level?: LogLevel;
  directory?: string;
  retentionDays?: number;
  logToStderr?: boolean;
}

export interface McpServerConfig<TContext = unknown> {
  name: string;
  version?: string;
  host?: string;
  port?: number;
  dataDir?: string;
  logging?: LoggingConfig;
  logger?: Logger;
  tools?: ToolDefinition<any, TContext>[];
  context?: () => Promise<TContext> | TContext;
  /**
   * Whether to track this server in the central registry (~/.mcponce/servers.json).
   * Defaults to true. Can be disabled per-server or via MCP_DISABLE_REGISTRY=1.
   */
  registerInCentral?: boolean;
  /**
   * Starts the shared MCP server as a detached background process managed by Unitup.
   * Defaults to false (native in-process on-demand lifecycle).
   */
  background?: boolean;
  /**
   * Optional custom entrypoint script or binary path for background process execution.
   * Defaults to process.argv[1].
   */
  entrypoint?: string;
  /**
   * Default timeout in milliseconds for tool execution.
   * Defaults to 60000ms (1 minute). Set to 0 to disable default timeout.
   */
  toolTimeoutMs?: number;
  /**
   * If true, executes tool calls across this server sequentially (FIFO queue, concurrency: 1).
   * Prevents taking or executing another tool call before the active one completes.
   * Defaults to false.
   */
  sequential?: boolean;
  /**
   * Maximum concurrent tool executions across this server.
   * Defaults to undefined (unlimited). When sequential is true, maxConcurrency is 1.
   */
  maxConcurrency?: number;
  /**
   * If true, automatically coerces incoming tool arguments to their expected schema types
   * (e.g. "42" -> 42, "false" -> false, stringified JSON to objects/arrays).
   * Defaults to false. Can be enabled globally via MCP_COERCE_INPUTS=true.
   */
  coerceInputs?: boolean;
  /**
   * Initial middleware handlers registered on this server.
   */
  middleware?: (ToolMiddlewareHandler<TContext> | ConfiguredMiddleware<TContext>)[];
  /**
   * Optional API key or list of valid keys for HTTP/SSE endpoint authentication.
   * When set, incoming requests must provide `Authorization: Bearer <key>` or `x-api-key: <key>`.
   * Can also be set via MCPONCE_API_KEY or MCP_API_KEY environment variable.
   */
  apiKey?: string | string[];
  /**
   * Custom authentication validator (e.g. for JWT verification, DB lookups, or RBAC scopes).
   */
  auth?: {
    apiKey?: string | string[];
    validate?: AuthValidator;
    excludedPaths?: string[];
  };
  /**
   * In-memory sliding window rate limiting to protect against DDoS or client query loops.
   */
  rateLimit?: RateLimitConfig;
  /**
   * Custom CORS configuration for HTTP/SSE endpoints.
   */
  cors?: CorsConfig;
  /**
   * Optional custom handler or fallback for sampling requests (sampling/createMessage).
   * Invoked when testing offline, or when the client does not support sampling.
   */
  onSample?: SampleHandler;
  /**
   * Optional custom handler or fallback for workspace roots requests (roots/list).
   */
  onListRoots?: ListRootsHandler;
}

export interface AuthIdentity {
  id?: string;
  user?: string;
  clientId?: string;
  token?: string;
  role?: string;
  scopes?: string[];
  metadata?: Record<string, any>;
}

export type AuthValidator = (
  token: string | undefined,
  context: { path: string; method?: string; headers: Record<string, string | undefined> }
) => Promise<boolean | AuthIdentity | null | undefined> | boolean | AuthIdentity | null | undefined;

export interface RateLimitConfig {
  max: number;
  windowMs?: number;
  message?: string;
}

export interface CorsConfig {
  origin?: string | string[] | ((origin: string) => boolean | string | undefined | null);
  credentials?: boolean;
  allowHeaders?: string[];
  exposeHeaders?: string[];
}

export type McpServerConfigInput<TContext = unknown> = McpServerConfig<TContext> | string;

export interface StartOptions {
  noSingleton?: boolean;
  background?: boolean;
}

export interface StopOptions {
  background?: boolean;
}

export interface RestartOptions {
  background?: boolean;
  noSingleton?: boolean;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  throwOnError?: boolean;
  /**
   * Override sequential / concurrency behavior for this specific invocation.
   */
  sequential?: boolean | string;
  /**
   * If true, bypasses the in-memory cache and forces fresh execution.
   */
  noCache?: boolean;
  bypassCache?: boolean;
  /**
   * Retry configuration for this invocation.
   * - number: number of retry attempts.
   * - ToolRetryConfig: custom retry settings.
   * - false: disables retries even if the tool configured them.
   */
  retry?: number | ToolRetryConfig | false;
  /**
   * If true, enables smart input coercion for this invocation.
   * If false, disables coercion even if configured on the tool or server.
   */
  coerceInputs?: boolean;
  /**
   * Optional callback triggered whenever the tool reports progress during execution.
   */
  onProgress?: (progress: ToolProgressNotification) => void | Promise<void>;
  /**
   * Optional progress token to associate with this invocation.
   */
  progressToken?: string | number;
  /**
   * Optional caller authentication identity.
   */
  auth?: AuthIdentity;
}

export interface ToolProgressReport {
  /**
   * Current progress value (e.g. current item index, percentage, or units processed).
   */
  progress: number;
  /**
   * Total units expected (optional).
   */
  total?: number;
  /**
   * Human-readable progress status message (optional).
   */
  message?: string;
}

export interface ToolProgressNotification extends ToolProgressReport {
  /**
   * The name of the tool reporting progress.
   */
  tool: string;
  /**
   * The client-provided progress token, if any.
   */
  progressToken?: string | number;
  /**
   * ISO timestamp of the progress event.
   */
  timestamp: string;
}

export interface ToolProgressReporter {
  (report: ToolProgressReport): Promise<void>;
  (progress: number, total?: number, message?: string): Promise<void>;
}

export type NextFunction = () => Promise<any>;

export interface ToolMiddlewareContext<TContext = any> {
  /**
   * The name of the tool being executed.
   */
  tool: string;
  /**
   * The validated/coerced input arguments for this tool execution.
   * Can be inspected or mutated by middleware before calling next().
   */
  args: Record<string, any>;
  /**
   * The shared application context, enriched with runtime helpers.
   * Middleware can attach session, auth, or request metadata onto this object.
   */
  context: TContext & {
    callTool?: ToolExtra['callTool'];
    signal?: AbortSignal;
    clearCache?: ToolExtra['clearCache'];
    reportProgress?: ToolProgressReporter;
    sample?: ToolExtra['sample'];
    listRoots?: ToolExtra['listRoots'];
    [key: string]: any;
  };
  /**
   * Extra execution utilities (signal, callTool, clearCache, reportProgress, progressToken).
   */
  extra: ToolExtra;
  /**
   * Call options passed to the invocation (if invoked programmatically).
   */
  options?: CallOptions;
  /**
   * Invocation call stack for inter-tool tracing.
   */
  callStack: string[];
}

export type ToolMiddlewareHandler<TContext = any> = (
  ctx: ToolMiddlewareContext<TContext>,
  next: NextFunction
) => Promise<any> | any;

export type MiddlewareFilter = string | string[] | RegExp;

export interface ConfiguredMiddleware<TContext = unknown> {
  filter?: MiddlewareFilter;
  handler: ToolMiddlewareHandler<TContext>;
}

export interface ToolRetryConfig {
  /**
   * Maximum number of retry attempts after the initial failure.
   */
  attempts: number;
  /**
   * Initial backoff delay in milliseconds before the first retry.
   * Defaults to 100ms.
   */
  backoffMs?: number;
  /**
   * Multiplier for each subsequent backoff delay.
   * Defaults to 2 (exponential).
   */
  factor?: number;
  /**
   * Maximum backoff delay cap in milliseconds.
   * Defaults to 5000ms.
   */
  maxBackoffMs?: number;
  /**
   * Optional predicate to decide if an error should trigger a retry.
   * If returns false, fails immediately without further retries.
   */
  retryIf?: (error: any) => boolean;
}

export interface ToolCacheConfig {
  /**
   * Cache expiration time in milliseconds.
   * Defaults to 60_000 (1 minute).
   */
  ttlMs?: number;
  /**
   * Maximum number of cached response entries for this tool.
   * When exceeded, the least recently used (LRU) entry is evicted.
   * Defaults to 100.
   */
  maxSize?: number;
  /**
   * Optional custom cache key generator for input arguments.
   * If omitted, arguments are recursively serialized with sorted keys.
   */
  keyGenerator?: (args: Record<string, any>) => string;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

export type InputSchemaPropertyType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface InputSchemaPropertyConfig {
  type: InputSchemaPropertyType;
  description?: string;
  default?: any;
  required?: boolean;
  coerce?: boolean;
}

export type ShorthandInputSchema = Record<
  string,
  InputSchemaPropertyType | InputSchemaPropertyConfig | z.ZodTypeAny
>;

export type InputSchemaDefinition = ShorthandInputSchema | z.ZodRawShape | z.ZodObject<any>;

export interface ToolCallResult<TData = any> extends CallToolResult {
  data: TData;
  text: string;
}

export interface ToolExtra {
  signal?: AbortSignal;
  callTool: <TResult = any>(
    name: string,
    args?: Record<string, any>,
    options?: CallOptions
  ) => Promise<ToolCallResult<TResult>>;
  /**
   * Clears in-memory cache entries.
   * - If toolName is provided, clears entries for that tool only.
   * - If omitted, clears all cached entries across all tools.
   * Returns the count of evicted entries.
   */
  clearCache: (toolName?: string) => number;
  /**
   * Reports real-time progress for this tool execution.
   * Dispatches out-of-band MCP notifications/progress when a client progressToken is present,
   * and invokes any programmatic onProgress listener.
   */
  reportProgress: ToolProgressReporter;
  /**
   * The progress token assigned to this request, if provided by the client or caller.
   */
  progressToken?: string | number;
  /**
   * Requests LLM completion/sampling back from the connected client via MCP sampling/createMessage.
   * If running offline or in tests, delegates to any fallback handler configured with app.onSample().
   */
  sample: (input: string | SampleOptions, options?: Partial<SampleOptions>) => Promise<SampleResult>;
  /**
   * Requests the list of root workspace directories from the connected client via MCP roots/list.
   */
  listRoots: () => Promise<Root[]>;
  /**
   * Authenticated caller identity, if authentication was performed.
   */
  auth?: AuthIdentity;
}

export type CompleteHandler = (
  value: string,
  context?: { argument?: Record<string, any>; [key: string]: any }
) => Promise<string[]> | string[];

export interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

export interface ToolDefinition<TInput = any, TContext = unknown> {
  name: string;
  description?: string;
  inputSchema?: InputSchemaDefinition;
  /**
   * Optional autocompletion functions for tool parameters.
   */
  complete?: Record<string, CompleteHandler>;
  /**
   * Required permission scopes to execute this tool.
   * If provided, the authenticated identity's scopes must include all required scopes.
   */
  scopes?: string[];
  /**
   * If true, explicitly requires authentication to invoke this tool.
   */
  requireAuth?: boolean;
  /**
   * Timeout in milliseconds for this specific tool.
   * Set to 0 to disable timeout. Overrides server-level toolTimeoutMs.
   */
  timeoutMs?: number;
  /**
   * Concurrency control for this specific tool.
   * - If true: executions of this tool are queued sequentially (concurrency: 1).
   * - If string: acts as a named mutex / queue key shared across multiple tools
   *   (e.g., sequential: "browser" ensures click, type, and navigate never run concurrently).
   * - If false: runs without sequential queueing.
   */
  sequential?: boolean | string;
  /**
   * Maximum concurrent executions for this specific tool.
   * Defaults to undefined (inherits server-level concurrency or unlimited).
   */
  maxConcurrency?: number;
  /**
   * In-memory response caching configuration.
   * - If true: enables response caching with default 60s TTL and 100 entry limit.
   * - If object: configures custom ttlMs, maxSize, or keyGenerator.
   * - If undefined or false: caching disabled (default).
   */
  cache?: boolean | ToolCacheConfig;
  /**
   * Automatic retry configuration for transient errors.
   * - number: number of retry attempts with default exponential backoff.
   * - ToolRetryConfig: detailed retry settings (attempts, backoffMs, factor, retryIf).
   */
  retry?: number | ToolRetryConfig;
  /**
   * If true, automatically coerces stringified inputs (numbers, booleans, JSON objects/arrays)
   * to match the tool's input schema.
   * Overrides server-level coerceInputs.
   */
  coerceInputs?: boolean;
  /**
   * Optional tool-specific middleware handlers executed exclusively for this tool.
   */
  middleware?: ToolMiddlewareHandler<TContext>[];
  handler: (
    input: TInput,
    context: TContext & {
      callTool?: ToolExtra['callTool'];
      signal?: AbortSignal;
      clearCache?: ToolExtra['clearCache'];
      reportProgress?: ToolProgressReporter;
      sample?: ToolExtra['sample'];
      listRoots?: ToolExtra['listRoots'];
      auth?: AuthIdentity;
    },
    extra: ToolExtra
  ) => Promise<any> | any;
}

export interface ResourceDefinition<TContext = unknown> {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  handler: (uri: URL, context: TContext) => Promise<ReadResourceResult | any> | ReadResourceResult | any;
}

export interface ResourceTemplateCompleteHandler {
  (value: string, context?: { arguments?: Record<string, string> }): Promise<string[]> | string[];
}

export interface ResourceTemplateDefinition<TContext = unknown> {
  /**
   * RFC 6570 URI template string (e.g. "users://{userId}/profile" or "memo://{category}/{id}").
   */
  uriTemplate: string;
  /**
   * Optional human-readable name or unique identifier for the template. Defaults to uriTemplate.
   */
  name?: string;
  /**
   * Optional human-readable description for what this resource represents.
   */
  description?: string;
  /**
   * Optional default MIME type for resources returned by this template.
   */
  mimeType?: string;
  /**
   * Optional autocompletion functions for template parameters.
   * Maps variable names to autocompletion handler callbacks.
   */
  complete?: Record<string, ResourceTemplateCompleteHandler>;
  /**
   * Optional callback to enumerate known concrete resources matching this template pattern.
   */
  list?: (context: TContext) => Promise<Resource[] | ListResourcesResult> | Resource[] | ListResourcesResult;
  /**
   * Handler executed when a resource matching this template URI pattern is read.
   * Receives the parsed URL, extracted parameters dictionary, and the server context.
   */
  handler: (
    uri: URL,
    params: Record<string, string>,
    context: TContext
  ) => Promise<ReadResourceResult | any> | ReadResourceResult | any;
}

export type AnyResourceDefinition<TContext = unknown> =
  | ResourceDefinition<TContext>
  | ResourceTemplateDefinition<TContext>;

export interface ResourceMatchResult<TContext = unknown> {
  template: ResourceTemplateDefinition<TContext>;
  params: Record<string, string>;
}

export interface PromptDefinition<TArgs = any, TContext = unknown> {
  name: string;
  description?: string;
  argsSchema?: Record<string, z.ZodTypeAny | string>;
  /**
   * Optional autocompletion functions for prompt arguments.
   */
  complete?: Record<string, CompleteHandler>;
  handler: (args: TArgs, context: TContext) => Promise<GetPromptResult> | GetPromptResult;
}

export type ServerStatus =
  | {
      status: 'running';
      role: 'owner' | 'bridge';
      pid: number;
      port: number;
      host: string;
      startedAt: string;
      dataDir: string;
      logDir: string;
      activeSessions: number;
      totalSessions: number;
    }
  | {
      status: 'stopped';
      dataDir?: string;
      logDir?: string;
    };

export interface StartResult {
  reused: boolean;
  role: 'owner' | 'bridge';
  pid: number;
  port: number;
  host: string;
}

export interface RuntimeState {
  name: string;
  version: string;
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  pid: number;
  version: string;
}

export interface InfoResponse {
  name: string;
  version: string;
  status: 'running';
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  activeSessions: number;
  totalSessions: number;
  lastClientConnection?: string;
  lastToolInvocation?: {
    name: string;
    timestamp: string;
  };
  analytics?: ServerAnalyticsSummary;
}

export type ToolInvocationStatus = 'success' | 'error' | 'timeout' | 'cancelled';

export interface ToolMetric {
  name: string;
  calls: number;
  success: number;
  errors: number;
  timeouts: number;
  cancellations: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  lastInvokedAt?: string;
  cacheHits?: number;
  retries?: number;
  callers: Record<string, number>;
  invokedTools: Record<string, number>;
}

export interface InterToolRelationship {
  caller: string;
  target: string;
  count: number;
}

export interface RecentToolInvocation {
  id: number;
  tool: string;
  caller?: string;
  durationMs: number;
  status: ToolInvocationStatus;
  timestamp: string;
  errorMessage?: string;
  isCacheHit?: boolean;
  retries?: number;
}

export interface ServerAnalyticsSummary {
  totalInvocations: number;
  successfulInvocations: number;
  failedInvocations: number;
  timeoutInvocations: number;
  cancelledInvocations: number;
  cachedInvocations?: number;
  totalRetries?: number;
  totalExecutionTimeMs: number;
  averageExecutionTimeMs: number;
  totalInterToolCalls: number;
}

export interface ServerAnalytics {
  startedAt: string;
  generatedAt: string;
  summary: ServerAnalyticsSummary;
  tools: Record<string, ToolMetric>;
  interToolCalls: InterToolRelationship[];
  recentInvocations: RecentToolInvocation[];
}

export interface PrometheusExportOptions {
  serverName?: string;
  version?: string;
  activeSessions?: number;
  totalSessions?: number;
  uptimeSeconds?: number;
  cacheStats?: CacheStats;
}

