import type { PromptRegistry } from '../registry/prompts.js';
import type { ResourceRegistry } from '../registry/resources.js';
import type { ToolRegistry } from '../registry/tools.js';
import type { CompletionResult } from '../types.js';

export interface CompletionRef {
  type: 'ref/prompt' | 'ref/resource' | 'ref/tool' | string;
  name?: string;
  uri?: string;
}

export interface CompletionArgument {
  name: string;
  value: string;
}

/**
 * Deduplicates, filters by query prefix/substring, and caps suggestions to 100 items
 * as required by the Model Context Protocol completion specification.
 */
export function filterCompletionValues(values: string[], query: string): CompletionResult {
  const q = (query || '').toLowerCase();
  const unique = Array.from(new Set(values.map((v) => String(v))));

  // Sort prefix matches first, followed by substring matches
  const matched = unique.filter((val) => val.toLowerCase().includes(q));
  matched.sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aPrefix = aLower.startsWith(q);
    const bPrefix = bLower.startsWith(q);

    if (aPrefix && !bPrefix) return -1;
    if (!aPrefix && bPrefix) return 1;
    return aLower.localeCompare(bLower);
  });

  const total = matched.length;
  const capped = matched.slice(0, 100);

  return {
    values: capped,
    total,
    hasMore: total > 100
  };
}

/**
 * Resolves autocompletions for prompts, resource templates, and tools.
 */
export async function resolveCompletion(options: {
  promptRegistry?: PromptRegistry<any>;
  resourceRegistry?: ResourceRegistry<any>;
  toolRegistry?: ToolRegistry<any>;
  ref: CompletionRef;
  argument: CompletionArgument;
  context?: any;
}): Promise<CompletionResult> {
  const { promptRegistry, resourceRegistry, toolRegistry, ref, argument, context } = options;

  if (!ref || !argument || !argument.name) {
    return { values: [], total: 0, hasMore: false };
  }

  try {
    // 1. Prompt autocompletion
    if (ref.type === 'ref/prompt') {
      const prompt = promptRegistry?.get(ref.name || '');
      if (prompt && prompt.complete && prompt.complete[argument.name]) {
        const handler = prompt.complete[argument.name];
        const raw = await handler(argument.value || '', context);
        return filterCompletionValues(Array.isArray(raw) ? raw : [], argument.value);
      }
      return { values: [], total: 0, hasMore: false };
    }

    // 2. Resource Template autocompletion
    if (ref.type === 'ref/resource') {
      const templates = resourceRegistry?.getAllTemplates ? resourceRegistry.getAllTemplates() : [];
      const targetUri = ref.uri || '';

      const matchedTemplate = templates.find((t) => {
        return t.uriTemplate === targetUri || t.name === targetUri;
      });

      if (matchedTemplate && matchedTemplate.complete && matchedTemplate.complete[argument.name]) {
        const handler = matchedTemplate.complete[argument.name];
        const raw = await handler(argument.value || '', context);
        return filterCompletionValues(Array.isArray(raw) ? raw : [], argument.value);
      }
      return { values: [], total: 0, hasMore: false };
    }

    // 3. Tool argument autocompletion
    if (ref.type === 'ref/tool') {
      const tool = toolRegistry?.get(ref.name || '');
      if (tool && tool.complete && tool.complete[argument.name]) {
        const handler = tool.complete[argument.name];
        const raw = await handler(argument.value || '', context);
        return filterCompletionValues(Array.isArray(raw) ? raw : [], argument.value);
      }
      return { values: [], total: 0, hasMore: false };
    }
  } catch {
    // Autocompletion failure should never crash the session
    return { values: [], total: 0, hasMore: false };
  }

  return { values: [], total: 0, hasMore: false };
}
