import type { RegisteredTool } from '../registry/tools.js';

export interface ParsedCliToolArgs {
  params: Record<string, any>;
  isJsonOutput: boolean;
  timeoutMs?: number;
  isHelp: boolean;
  noCache?: boolean;
  noProgress?: boolean;
  token?: string;
}

/**
 * Automatically infers and parses primitive types from CLI string values.
 * - 'true' / 'false' -> boolean
 * - 'null' -> null
 * - Numeric strings -> number
 * - JSON arrays or objects -> parsed JSON
 * - Plain text -> string
 */
export function parseCliValue(val: string): any {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;

  // Numbers (integers, floats, negative numbers, scientific notation)
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(val) && !isNaN(Number(val))) {
    return Number(val);
  }

  // JSON objects or arrays
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fallback to plain string if invalid JSON
      return val;
    }
  }

  return val;
}

/**
 * Parses CLI arguments into structured tool parameters and runner options.
 *
 * Supported syntaxes:
 *   --key value
 *   --key=value
 *   -k value
 *   -k=value
 *   --flag (true)
 *   --no-flag (false)
 *   '{"json": "payload"}' (positional base JSON object)
 *
 * Special runner flags:
 *   --json          (outputs raw JSON result)
 *   --timeout <ms>  (sets tool timeout)
 *   --no-cache      (bypasses in-memory tool cache)
 *   --help, -h      (displays parameter schema help)
 */
export function parseParametricArgs(args: string[]): ParsedCliToolArgs {
  let params: Record<string, any> = {};
  let isJsonOutput = false;
  let timeoutMs: number | undefined;
  let isHelp = false;
  let noCache = false;
  let noProgress = false;
  let token: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Check for CLI control flags
    if (arg === '--help' || arg === '-h') {
      isHelp = true;
      continue;
    }

    if (arg === '--json') {
      isJsonOutput = true;
      continue;
    }

    if (arg === '--no-cache') {
      noCache = true;
      params.cache = false;
      continue;
    }

    if (arg === '--no-progress') {
      noProgress = true;
      continue;
    }

    if (arg === '--token' || arg === '--api-key') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        token = next;
        i++;
      }
      continue;
    }

    if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length);
      continue;
    }

    if (arg.startsWith('--api-key=')) {
      token = arg.slice('--api-key='.length);
      continue;
    }

    if (arg === '--timeout') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        const parsedTimeout = parseInt(next, 10);
        if (!isNaN(parsedTimeout)) {
          timeoutMs = parsedTimeout;
        }
        i++;
      }
      continue;
    }

    if (arg.startsWith('--timeout=')) {
      const parsedTimeout = parseInt(arg.slice('--timeout='.length), 10);
      if (!isNaN(parsedTimeout)) {
        timeoutMs = parsedTimeout;
      }
      continue;
    }

    // Positional JSON payload e.g. '{"operation": "add", "a": 10}'
    if (arg.startsWith('{') && arg.endsWith('}')) {
      try {
        const parsedObj = JSON.parse(arg);
        if (typeof parsedObj === 'object' && parsedObj !== null && !Array.isArray(parsedObj)) {
          params = { ...params, ...parsedObj };
          continue;
        }
      } catch {
        // Not valid JSON, continue to next checks
      }
    }

    // Negated boolean flag e.g. --no-cache, --no-save
    if (arg.startsWith('--no-')) {
      const key = arg.slice(5);
      if (key.length > 0) {
        params[key] = false;
        continue;
      }
    }

    // Key=value syntax: --param=value or -p=value
    if (arg.startsWith('-') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      const rawKey = arg.slice(0, eqIdx).replace(/^-+/, '');
      const rawVal = arg.slice(eqIdx + 1);
      if (rawKey.length > 0) {
        params[rawKey] = parseCliValue(rawVal);
        continue;
      }
    }

    // Standard flag: --key value or --flag
    if (arg.startsWith('-')) {
      const rawKey = arg.replace(/^-+/, '');
      const nextArg = args[i + 1];

      // If next argument exists and is not another flag, treat it as the value
      if (nextArg !== undefined && !nextArg.startsWith('-')) {
        params[rawKey] = parseCliValue(nextArg);
        i++;
      } else {
        // Standalone flag defaults to true
        params[rawKey] = true;
      }
      continue;
    }
  }

  return {
    params,
    isJsonOutput,
    timeoutMs,
    isHelp,
    noCache,
    noProgress,
    token
  };
}

export interface ParameterInfo {
  type: string;
  required: boolean;
  default?: any;
  description?: string;
}

/**
 * Extracts a human-readable type description, optionality, default value, and description for a tool parameter.
 */
export function getParameterInfo(
  key: string,
  tool: RegisteredTool
): ParameterInfo {
  const schema = tool.inputSchema as Record<string, any> | undefined;
  if (schema && typeof schema[key] === 'string') {
    return { type: schema[key] as string, required: true };
  }

  if (schema && typeof schema[key] === 'object' && schema[key] !== null) {
    const prop = schema[key] as any;
    if (typeof prop.type === 'string' && !('_def' in prop)) {
      const isRequired = prop.required !== undefined ? prop.required : (prop.default === undefined);
      return {
        type: prop.type,
        required: isRequired,
        default: prop.default,
        description: prop.description
      };
    }
  }

  const normalized = tool.normalizedSchema?.[key];
  if (normalized) {
    let current: any = normalized;
    let isOptional = false;
    let defaultValue: any = undefined;
    let description: string | undefined = (normalized as any).description;

    while (current && current._def) {
      const def = current._def;
      if (def.description && !description) {
        description = def.description;
      }
      if (def.typeName === 'ZodOptional') {
        isOptional = true;
        current = def.innerType;
      } else if (def.typeName === 'ZodDefault') {
        isOptional = true;
        defaultValue = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
        current = def.innerType;
      } else if (def.typeName === 'ZodEffects') {
        current = def.schema;
      } else {
        break;
      }
    }

    const typeName = current?._def?.typeName || 'any';
    return {
      type: formatZodTypeName(typeName),
      required: !isOptional,
      default: defaultValue,
      description
    };
  }

  return { type: 'any', required: false };
}

function formatZodTypeName(zodTypeName: string): string {
  switch (zodTypeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return 'array';
    case 'ZodObject':
    case 'ZodRecord':
      return 'object';
    default:
      return zodTypeName.replace(/^Zod/, '').toLowerCase();
  }
}

/**
 * Prints detailed parameter schema, descriptions, and CLI usage for a single tool.
 */
export function printToolHelp(tool: RegisteredTool): void {
  console.log(`\n\x1b[1mTool: ${tool.name}\x1b[0m`);
  if (tool.description) {
    console.log(`${tool.description}\n`);
  } else {
    console.log('');
  }

  const paramKeys = Object.keys(tool.normalizedSchema || tool.inputSchema || {});
  if (paramKeys.length === 0) {
    console.log('Parameters: None (this tool takes no arguments)\n');
    console.log(`Example:`);
    console.log(`  call ${tool.name}\n`);
    return;
  }

  console.log('\x1b[1mParameters:\x1b[0m');
  const exampleParts: string[] = [];

  for (const key of paramKeys) {
    const info = getParameterInfo(key, tool);
    const reqStr = info.required ? '\x1b[33m(required)\x1b[0m' : '\x1b[90m(optional)\x1b[0m';
    const defStr = info.default !== undefined ? ` \x1b[90m[default: ${JSON.stringify(info.default)}]\x1b[0m` : '';
    const descStr = info.description ? `\n      \x1b[90m${info.description}\x1b[0m` : '';
    console.log(`  --${key} <${info.type}> ${reqStr}${defStr}${descStr}`);

    if (info.type === 'number') {
      exampleParts.push(`--${key} ${info.default !== undefined ? info.default : 10}`);
    } else if (info.type === 'boolean') {
      exampleParts.push(`--${key} ${info.default !== undefined ? info.default : true}`);
    } else {
      exampleParts.push(`--${key} ${info.default !== undefined ? info.default : 'example'}`);
    }
  }

  console.log('\n\x1b[1mExample:\x1b[0m');
  console.log(`  call ${tool.name} ${exampleParts.join(' ')}\n`);
}

/**
 * Prints a summary list of all registered tools with descriptions and signatures.
 */
export function printToolsList(tools: RegisteredTool[]): void {
  console.log(`\n\x1b[1mRegistered Tools (${tools.length}):\x1b[0m\n`);

  if (tools.length === 0) {
    console.log('  No tools registered on this server.\n');
    return;
  }

  for (const t of tools) {
    const paramKeys = Object.keys(t.normalizedSchema || t.inputSchema || {});
    const signature = paramKeys.length > 0
      ? paramKeys.map(k => `--${k} <${getParameterInfo(k, t).type}>`).join(' ')
      : '(no parameters)';

    console.log(`  \x1b[1m\x1b[36m${t.name}\x1b[0m`);
    if (t.description) {
      console.log(`    ${t.description}`);
    }
    console.log(`    \x1b[90mUsage: call ${t.name} ${signature}\x1b[0m\n`);
  }

  console.log('Run with "--help" on any tool for detailed parameter info:');
  console.log(`  call <tool-name> --help\n`);
}

/**
 * Formats a progress notification for terminal stderr display.
 */
export function formatCliProgress(p: {
  tool: string;
  progress: number;
  total?: number;
  message?: string;
}): string {
  const pctStr =
    p.total !== undefined && p.total > 0
      ? ` (${Math.round((p.progress / p.total) * 100)}%)`
      : '';
  const totalStr = p.total !== undefined ? `/${p.total}` : '';
  const msgStr = p.message ? ` - ${p.message}` : '';
  return `\r\x1b[36m[Progress ${p.tool}]\x1b[0m ${p.progress}${totalStr}${pctStr}${msgStr}\x1b[K`;
}

/**
 * Executes a tool invocation from CLI arguments.
 */
export async function executeCliToolCall(
  app: any,
  toolName: string | undefined,
  rawArgs: string[]
): Promise<void> {
  const tools: RegisteredTool[] = app.getTools ? app.getTools() : [];

  if (!toolName || toolName === '--help' || toolName === '-h') {
    console.log('Usage: call <tool-name> [params...] [--json] [--timeout <ms>] [--no-progress]');
    console.log('');
    printToolsList(tools);
    return;
  }

  const tool = app.getTool ? app.getTool(toolName) : tools.find(t => t.name === toolName);
  if (!tool) {
    console.error(`\x1b[31mError:\x1b[0m Tool "${toolName}" not found.`);
    if (tools.length > 0) {
      console.error(`Available tools: ${tools.map(t => t.name).join(', ')}`);
      console.error(`Run "tools" command to see all registered tools.`);
    }
    process.exit(1);
  }

  const parsed = parseParametricArgs(rawArgs);

  if (parsed.isHelp) {
    printToolHelp(tool);
    return;
  }

  let hasReportedProgress = false;
  const onProgress = !parsed.noProgress
    ? (p: any) => {
        hasReportedProgress = true;
        process.stderr.write(formatCliProgress(p));
      }
    : undefined;

  try {
    const effectiveToken =
      parsed.token || process.env.MCP_TOKEN || process.env.MCP_API_KEY;
    const authIdentity = effectiveToken ? { token: effectiveToken } : undefined;

    const result = await app.callTool(toolName, parsed.params, {
      timeoutMs: parsed.timeoutMs,
      noCache: parsed.noCache,
      throwOnError: false,
      onProgress,
      auth: authIdentity
    });

    if (hasReportedProgress) {
      process.stderr.write('\r\x1b[K');
    }

    if (result.isError) {
      if (parsed.isJsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`\x1b[31mTool Error [${toolName}]:\x1b[0m ${result.text || 'Execution failed'}`);
      }
      process.exit(1);
    }

    if (parsed.isJsonOutput) {
      const output = result.data !== undefined ? result.data : result;
      console.log(JSON.stringify(output, null, 2));
    } else {
      if (typeof result.data === 'object' && result.data !== null) {
        console.log(JSON.stringify(result.data, null, 2));
      } else if (result.text) {
        console.log(result.text);
      } else if (result.data !== undefined) {
        console.log(String(result.data));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (err: any) {
    if (hasReportedProgress) {
      process.stderr.write('\r\x1b[K');
    }
    if (parsed.isJsonOutput) {
      console.log(JSON.stringify({ isError: true, error: err.message || String(err) }, null, 2));
    } else {
      console.error(`\x1b[31mError executing "${toolName}":\x1b[0m`, err.message || err);
    }
    process.exit(1);
  }
}
