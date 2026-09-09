import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ResourceDefinition,
  ResourceTemplateDefinition,
  ResourceMatchResult
} from '../types.js';

export interface ResourceTemplateEntry<TContext = unknown> {
  definition: ResourceTemplateDefinition<TContext>;
  sdkTemplate: ResourceTemplate;
}

export class ResourceRegistry<TContext = unknown> {
  private resources = new Map<string, ResourceDefinition<TContext>>();
  private templates = new Map<string, ResourceTemplateEntry<TContext>>();

  /**
   * Registers a static resource with an exact URI.
   */
  register(resource: ResourceDefinition<TContext>): void {
    if (!resource.uri || typeof resource.uri !== 'string') {
      throw new Error('Resource uri must be a non-empty string');
    }
    this.resources.set(resource.uri, resource);
  }

  /**
   * Registers a dynamic RFC 6570 resource template.
   */
  registerTemplate(template: ResourceTemplateDefinition<TContext>): void {
    if (!template.uriTemplate || typeof template.uriTemplate !== 'string') {
      throw new Error('Resource template uriTemplate must be a non-empty string');
    }

    const sdkTemplate = new ResourceTemplate(template.uriTemplate, {
      list: undefined,
      complete: template.complete
    });

    this.templates.set(template.uriTemplate, {
      definition: template,
      sdkTemplate
    });
  }

  /**
   * Retrieves a static resource by exact URI.
   */
  get(uri: string): ResourceDefinition<TContext> | undefined {
    return this.resources.get(uri);
  }

  /**
   * Retrieves a resource template by its URI template string or name.
   */
  getTemplate(key: string): ResourceTemplateDefinition<TContext> | undefined {
    const direct = this.templates.get(key);
    if (direct) {
      return direct.definition;
    }
    for (const entry of this.templates.values()) {
      if (entry.definition.name === key) {
        return entry.definition;
      }
    }
    return undefined;
  }

  /**
   * Returns all registered static resources.
   */
  getAll(): ResourceDefinition<TContext>[] {
    return Array.from(this.resources.values());
  }

  /**
   * Returns all registered resource template definitions.
   */
  getAllTemplates(): ResourceTemplateDefinition<TContext>[] {
    return Array.from(this.templates.values()).map((t) => t.definition);
  }

  /**
   * Returns all registered template entries including their instantiated SDK ResourceTemplate.
   */
  getTemplateEntries(): ResourceTemplateEntry<TContext>[] {
    return Array.from(this.templates.values());
  }

  /**
   * Returns true if either a static resource or template exists matching the key.
   */
  has(key: string): boolean {
    return this.resources.has(key) || this.templates.has(key);
  }

  /**
   * Returns true if a template exists matching the uriTemplate or name.
   */
  hasTemplate(key: string): boolean {
    return this.getTemplate(key) !== undefined;
  }

  /**
   * Matches a concrete incoming URI against all registered resource templates.
   * If a match is found, returns the template definition and extracted parameters.
   */
  findMatchingTemplate(uri: string): ResourceMatchResult<TContext> | undefined {
    for (const entry of this.templates.values()) {
      const match = entry.sdkTemplate.uriTemplate.match(uri);
      if (match) {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(match)) {
          params[k] = Array.isArray(v) ? v.join(',') : String(v);
        }
        return {
          template: entry.definition,
          params
        };
      }
    }
    return undefined;
  }
}
