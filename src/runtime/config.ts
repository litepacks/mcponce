import type { McpServerConfig, McpServerConfigInput, LogLevel } from '../types.js';
import { resolveDataDir, resolveLogDir } from './paths.js';
import { validateServerName } from '../utils/validation.js';

export interface ResolvedConfig<TContext = unknown> {
  name: string;
  version: string;
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
  logLevel: LogLevel;
  retentionDays: number;
  logToStderr: boolean;
  registerInCentral: boolean;
  background: boolean;
  entrypoint?: string;
  toolTimeoutMs: number;
  sequential: boolean;
  maxConcurrency?: number;
  coerceInputs: boolean;
  apiKey?: string[];
  auth?: {
    apiKey?: string | string[];
    validate?: import('../types.js').AuthValidator;
    excludedPaths?: string[];
  };
  rateLimit?: import('../types.js').RateLimitConfig;
  cors?: import('../types.js').CorsConfig;
  rawConfig: McpServerConfig<TContext>;
}

export function resolveConfig<TContext = unknown>(
  configOrName: McpServerConfigInput<TContext>,
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig<TContext> {
  const config: McpServerConfig<TContext> =
    typeof configOrName === 'string' ? { name: configOrName } : configOrName;

  const name = validateServerName(config.name);

  const version = config.version || '1.0.0';

  const host =
    config.host ||
    env.MCP_SERVER_HOST ||
    '127.0.0.1';

  let port = config.port !== undefined ? config.port : (env.MCP_SERVER_PORT ? parseInt(env.MCP_SERVER_PORT, 10) : 0);
  if (isNaN(port) || port < 0) {
    port = 0;
  }

  const dataDir = resolveDataDir(name, config.dataDir, process.platform, env);
  const logDir = resolveLogDir(dataDir, config.logging?.directory, env);

  const envLogLevel = env.MCP_SERVER_LOG_LEVEL as LogLevel | undefined;
  const logLevel: LogLevel =
    config.logging?.level ||
    (['debug', 'info', 'warn', 'error'].includes(envLogLevel || '') ? envLogLevel! : 'info');

  const retentionDays =
    config.logging?.retentionDays !== undefined && config.logging.retentionDays >= 0
      ? config.logging.retentionDays
      : 7;

  const logToStderr = config.logging?.logToStderr ?? false;

  const registerInCentral =
    config.registerInCentral !== undefined
      ? config.registerInCentral
      : env.MCP_DISABLE_REGISTRY === '1' || env.MCP_DISABLE_CENTRAL === '1'
      ? false
      : true;

  const background =
    config.background !== undefined
      ? config.background
      : env.MCP_BACKGROUND === '1' || env.MCPONCE_BACKGROUND === '1';

  const toolTimeoutMs =
    config.toolTimeoutMs !== undefined
      ? config.toolTimeoutMs
      : (env.MCP_TOOL_TIMEOUT_MS ? parseInt(env.MCP_TOOL_TIMEOUT_MS, 10) : 60000);

  const sequential =
    config.sequential !== undefined
      ? config.sequential
      : env.MCP_SEQUENTIAL === '1';

  const maxConcurrency =
    config.maxConcurrency !== undefined && config.maxConcurrency > 0
      ? config.maxConcurrency
      : (sequential ? 1 : undefined);

  const coerceInputs =
    config.coerceInputs !== undefined
      ? config.coerceInputs
      : env.MCP_COERCE_INPUTS === '1' || env.MCP_COERCE_INPUTS === 'true';

  let apiKey: string[] | undefined;
  const rawApiKey = config.apiKey || config.auth?.apiKey;
  if (rawApiKey) {
    apiKey = Array.isArray(rawApiKey) ? rawApiKey : [rawApiKey];
  } else if (env.MCPONCE_API_KEY || env.MCP_API_KEY || env.MCP_TOKEN) {
    const rawEnv = env.MCPONCE_API_KEY || env.MCP_API_KEY || env.MCP_TOKEN || '';
    apiKey = rawEnv.split(',').map((k) => k.trim()).filter(Boolean);
    if (apiKey.length === 0) {
      apiKey = undefined;
    }
  }

  return {
    name,
    version,
    host,
    port,
    dataDir,
    logDir,
    logLevel,
    retentionDays,
    logToStderr,
    registerInCentral,
    background,
    entrypoint: config.entrypoint,
    toolTimeoutMs: isNaN(toolTimeoutMs) || toolTimeoutMs < 0 ? 60000 : toolTimeoutMs,
    sequential: Boolean(sequential || maxConcurrency === 1),
    maxConcurrency,
    coerceInputs: Boolean(coerceInputs),
    apiKey,
    auth: config.auth,
    rateLimit: config.rateLimit,
    cors: config.cors,
    rawConfig: config
  };
}
