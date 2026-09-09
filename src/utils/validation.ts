/**
 * Naming validation rules for MCP servers, tools, prompts, and schema parameters.
 *
 * Many LLM providers (OpenAI, Anthropic Claude, Google Gemini) and MCP clients
 * (Claude Desktop, Cursor, Antigravity) enforce strict naming requirements on tools
 * and function calls (e.g. OpenAI strictly rejects tool names with spaces, dots, or symbols).
 *
 * Similarly, server names are used for local filesystem paths and system daemon services
 * (Unitup / launchd / systemd), requiring safe, cross-platform naming without path traversal.
 */

export const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
export const PROMPT_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
export const SERVER_NAME_REGEX = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
export const PARAM_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
]);

/**
 * Returns true if the given tool name conforms to MCP and LLM function calling standards.
 */
export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME_REGEX.test(name);
}

/**
 * Validates a tool name according to MCP and LLM provider specifications (OpenAI, Anthropic, Gemini).
 * Throws a descriptive Error if the name is invalid.
 */
export function validateToolName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Tool name must be a non-empty string');
  }

  const trimmed = name.trim();

  if (trimmed.length > 64) {
    throw new Error(
      `Invalid tool name "${name}": name exceeds 64 characters (length: ${trimmed.length}). ` +
        `Most LLM providers (including OpenAI and Anthropic) reject tool names longer than 64 characters.`
    );
  }

  if (!TOOL_NAME_REGEX.test(trimmed)) {
    const suggested = sanitizeToolName(trimmed);
    let reason = 'Tool names must contain only alphanumeric characters, underscores (_), and hyphens (-).';
    if (/\s/.test(trimmed)) {
      reason += ' Whitespace and spaces are not allowed.';
    }
    if (/[./\\]/.test(trimmed)) {
      reason += ' Dots, slashes, and path separators are not allowed.';
    }
    if (/[^a-zA-Z0-9_-\s./\\]/.test(trimmed)) {
      reason += ' Special symbols and unicode characters are not allowed.';
    }

    const suggestion = suggested ? ` Suggested valid alternative: "${suggested}".` : '';
    throw new Error(
      `Invalid tool name "${name}". ${reason}${suggestion} ` +
        `AI models and MCP clients (OpenAI, Claude, Cursor) reject tool names that do not match /^[a-zA-Z0-9_-]{1,64}$/.`
    );
  }

  return trimmed;
}

/**
 * Returns true if the given prompt name is valid.
 */
export function isValidPromptName(name: unknown): name is string {
  return typeof name === 'string' && PROMPT_NAME_REGEX.test(name);
}

/**
 * Validates an MCP prompt name.
 */
export function validatePromptName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Prompt name must be a non-empty string');
  }

  const trimmed = name.trim();

  if (trimmed.length > 64) {
    throw new Error(`Invalid prompt name "${name}": exceeds maximum length of 64 characters.`);
  }

  if (!PROMPT_NAME_REGEX.test(trimmed)) {
    const suggested = sanitizeToolName(trimmed);
    const suggestion = suggested ? ` Suggested valid alternative: "${suggested}".` : '';
    throw new Error(
      `Invalid prompt name "${name}". Prompt names must match /^[a-zA-Z0-9_-]{1,64}$/.${suggestion}`
    );
  }

  return trimmed;
}

/**
 * Returns true if the given server name is safe for filesystem directories and service names.
 */
export function isValidServerName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    return false;
  }
  if (WINDOWS_RESERVED_NAMES.has(name.toLowerCase())) {
    return false;
  }
  return SERVER_NAME_REGEX.test(name);
}

/**
 * Validates an MCP server name.
 */
export function validateServerName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('MCP server "name" is required and must be a non-empty string');
  }

  const trimmed = name.trim();

  if (trimmed.length > 128) {
    throw new Error(
      `Invalid server name "${name}": exceeds maximum length of 128 characters (length: ${trimmed.length}).`
    );
  }

  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(
      `Invalid server name "${name}": cannot contain path separators ("/", "\\") or directory traversal ("..").`
    );
  }

  if (WINDOWS_RESERVED_NAMES.has(trimmed.toLowerCase())) {
    throw new Error(
      `Invalid server name "${name}": "${trimmed}" is a reserved system device name and cannot be used as an application directory.`
    );
  }

  if (!SERVER_NAME_REGEX.test(trimmed)) {
    const suggested = sanitizeServerName(trimmed);
    const suggestion = suggested ? ` Suggested valid alternative: "${suggested}".` : '';
    throw new Error(
      `Invalid server name "${name}". Server names must contain only alphanumeric characters, underscores (_), hyphens (-), and single internal dots (.).${suggestion}`
    );
  }

  return trimmed;
}

/**
 * Validates an input parameter name in a tool schema.
 */
export function validateParameterName(paramName: string, toolName?: string): string {
  if (typeof paramName !== 'string' || paramName.trim().length === 0) {
    throw new Error(
      `Invalid parameter name in schema${toolName ? ` for tool "${toolName}"` : ''}: must be a non-empty string.`
    );
  }

  const trimmed = paramName.trim();

  if (trimmed.length > 64 || !PARAM_NAME_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid parameter name "${paramName}"${toolName ? ` in tool "${toolName}"` : ''}. ` +
        `Parameter names must match /^[a-zA-Z0-9_-]{1,64}$/ to ensure compatibility with LLM function calling schemas.`
    );
  }

  return trimmed;
}

/**
 * Sanitizes a string into a valid tool name matching /^[a-zA-Z0-9_-]{1,64}$/.
 */
export function sanitizeToolName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
}

/**
 * Sanitizes a string into a valid server name matching /^[a-zA-Z0-9_.-]{1,128}$/.
 */
export function sanitizeServerName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 128);
}
