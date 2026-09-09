import { CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';

export interface SamplingMessage {
  role: 'user' | 'assistant';
  content: string | { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
}

export interface ModelPreferences {
  hints?: Array<{ name?: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface SampleOptions {
  /**
   * Shorthand prompt text. If provided, converted to a single user message.
   */
  prompt?: string;
  /**
   * Explicit array of chat messages.
   */
  messages?: SamplingMessage[];
  /**
   * Optional system prompt instructing the model.
   */
  systemPrompt?: string;
  /**
   * Maximum tokens to generate (defaults to 1000).
   */
  maxTokens?: number;
  /**
   * Temperature for model sampling (0.0 to 1.0).
   */
  temperature?: number;
  /**
   * Model selection preferences and prioritization.
   */
  modelPreferences?: ModelPreferences;
  /**
   * Context inclusion strategy: 'none' | 'thisServer' | 'allServers'.
   */
  includeContext?: 'none' | 'thisServer' | 'allServers';
  /**
   * Optional stop sequences.
   */
  stopSequences?: string[];
  /**
   * Optional metadata dictionary.
   */
  metadata?: Record<string, unknown>;
  /**
   * Abort signal to cancel the request.
   */
  signal?: AbortSignal;
  /**
   * Optional request timeout in milliseconds.
   */
  timeoutMs?: number;
}

export interface NormalizedSampleParams {
  messages: Array<{
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
  }>;
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  modelPreferences?: ModelPreferences;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface SampleResult {
  role: 'assistant';
  content: any;
  model?: string;
  stopReason?: string;
  text: string;
  data?: any;
  toString(): string;
}

export type SampleHandler = (
  params: NormalizedSampleParams,
  options?: { signal?: AbortSignal }
) => Promise<SampleResult | CreateMessageResult | string | any> | SampleResult | CreateMessageResult | string | any;

export interface Root {
  uri: string;
  name?: string;
}

export type ListRootsHandler = (
  options?: { signal?: AbortSignal }
) => Promise<Root[]> | Root[];

/**
 * Normalizes string or object sampling inputs into protocol-compliant params.
 */
export function normalizeSampleInput(
  input: string | SampleOptions,
  extraOptions?: Partial<SampleOptions>
): NormalizedSampleParams {
  const merged: SampleOptions =
    typeof input === 'string'
      ? { prompt: input, ...extraOptions }
      : { ...input, ...extraOptions };

  const maxTokens =
    typeof merged.maxTokens === 'number' && merged.maxTokens > 0
      ? merged.maxTokens
      : 1000;

  const messages: Array<{
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
  }> = [];

  if (merged.prompt !== undefined) {
    messages.push({
      role: 'user',
      content: { type: 'text', text: String(merged.prompt) }
    });
  }

  if (Array.isArray(merged.messages)) {
    for (const msg of merged.messages) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      if (typeof msg.content === 'string') {
        messages.push({
          role,
          content: { type: 'text', text: msg.content }
        });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === 'object' && ('text' in item || 'data' in item)) {
            messages.push({ role, content: item as any });
          }
        }
      } else if (msg.content && typeof msg.content === 'object') {
        messages.push({ role, content: msg.content as any });
      }
    }
  }

  // If no messages constructed at all, add a fallback empty user message
  if (messages.length === 0) {
    messages.push({
      role: 'user',
      content: { type: 'text', text: '' }
    });
  }

  const result: NormalizedSampleParams = {
    messages,
    maxTokens
  };

  if (merged.systemPrompt !== undefined) result.systemPrompt = merged.systemPrompt;
  if (merged.temperature !== undefined) result.temperature = merged.temperature;
  if (merged.modelPreferences !== undefined) result.modelPreferences = merged.modelPreferences;
  if (merged.includeContext !== undefined) result.includeContext = merged.includeContext;
  if (merged.stopSequences !== undefined) result.stopSequences = merged.stopSequences;
  if (merged.metadata !== undefined) result.metadata = merged.metadata;

  return result;
}

/**
 * Normalizes raw SDK or custom sampling result into an ergonomic SampleResult.
 */
export function normalizeSampleResult(raw: any): SampleResult {
  if (typeof raw === 'string') {
    let parsedData: any = undefined;
    try {
      parsedData = JSON.parse(raw);
    } catch {}

    const res: SampleResult = {
      role: 'assistant',
      content: { type: 'text', text: raw },
      text: raw,
      data: parsedData,
      toString() {
        return this.text;
      }
    };
    return res;
  }

  let text = '';
  if (raw && typeof raw === 'object') {
    if (typeof raw.text === 'string') {
      text = raw.text;
    } else if (raw.content) {
      if (Array.isArray(raw.content)) {
        const textParts = raw.content
          .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text);
        text = textParts.join('\n');
      } else if (typeof raw.content === 'object' && raw.content.type === 'text' && typeof raw.content.text === 'string') {
        text = raw.content.text;
      }
    }
  }

  let parsedData = raw?.data;
  if (parsedData === undefined && text) {
    try {
      parsedData = JSON.parse(text);
    } catch {}
  }

  const res: SampleResult = {
    role: 'assistant',
    content: raw?.content || { type: 'text', text },
    model: raw?.model,
    stopReason: raw?.stopReason,
    text,
    data: parsedData,
    toString() {
      return this.text;
    }
  };

  return res;
}

/**
 * Executes a sampling request across the connected MCP session server or fallback handler.
 */
export async function executeSample(
  input: string | SampleOptions,
  extraOptions: Partial<SampleOptions> | undefined,
  sessionServer: any,
  fallbackHandler: SampleHandler | undefined,
  defaultSignal?: AbortSignal
): Promise<SampleResult> {
  const params = normalizeSampleInput(input, extraOptions);
  const optionsMerged = typeof input === 'object' ? { ...input, ...extraOptions } : extraOptions;
  const signal = optionsMerged?.signal || defaultSignal;

  // 1. Try sending request through active MCP server session if connected
  if (sessionServer && sessionServer.server && typeof sessionServer.server.createMessage === 'function') {
    try {
      const sdkResult = await sessionServer.server.createMessage(params, { signal });
      return normalizeSampleResult(sdkResult);
    } catch (err: any) {
      // If client explicitly doesn't support sampling or fails, check fallback handler
      if (fallbackHandler) {
        const fallbackRes = await fallbackHandler(params, { signal });
        return normalizeSampleResult(fallbackRes);
      }
      throw new Error(
        `Sampling request failed: ${err?.message || String(err)}. ` +
        `Ensure the connected client (Claude Desktop, Cursor) supports sampling (sampling/createMessage), ` +
        `or configure a fallback handler via app.onSample((params) => ...).`
      );
    }
  }

  // 2. No active session with createMessage: try fallback handler
  if (fallbackHandler) {
    const fallbackRes = await fallbackHandler(params, { signal });
    return normalizeSampleResult(fallbackRes);
  }

  // 3. Neither connected client nor fallback handler
  throw new Error(
    `Sampling is unavailable: No connected client session supporting sampling/createMessage is active, ` +
    `and no fallback handler was configured. To enable sampling during testing or standalone runs, ` +
    `register a handler with app.onSample((params) => ...).`
  );
}

/**
 * Executes a roots/list request across the connected MCP session server or fallback handler.
 */
export async function executeListRoots(
  sessionServer: any,
  fallbackHandler: ListRootsHandler | undefined,
  defaultSignal?: AbortSignal
): Promise<Root[]> {
  if (sessionServer && sessionServer.server && typeof sessionServer.server.listRoots === 'function') {
    try {
      const sdkResult = await sessionServer.server.listRoots({}, { signal: defaultSignal });
      return sdkResult?.roots || [];
    } catch (err) {
      if (fallbackHandler) {
        return await fallbackHandler({ signal: defaultSignal });
      }
      return [];
    }
  }

  if (fallbackHandler) {
    return await fallbackHandler({ signal: defaultSignal });
  }

  return [];
}
