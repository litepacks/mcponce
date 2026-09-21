import { z } from 'zod';
import type {
  ToolDefinition,
  InputSchemaDefinition,
  InputSchemaPropertyType,
  InputSchemaPropertyConfig
} from '../types.js';
import { validateToolName, validateParameterName } from '../utils/validation.js';
import {
  buildCoercedZodSchema,
  coerceNumber,
  coerceBoolean
} from '../utils/coercion.js';

function getBaseZodType(type: InputSchemaPropertyType | string): z.ZodTypeAny {
  switch (type.toLowerCase()) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(z.any());
    case 'object':
      return z.record(z.any());
    default:
      return z.any();
  }
}

export function isInputSchemaPropertyConfig(val: any): val is InputSchemaPropertyConfig {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof val.type === 'string' &&
    !('_def' in val) &&
    typeof val.parse !== 'function'
  );
}

export interface NormalizeInputSchemaOptions {
  coerceInputs?: boolean;
}

export function normalizeInputSchema(
  schema?: InputSchemaDefinition,
  toolName?: string,
  options?: NormalizeInputSchemaOptions
): Record<string, z.ZodTypeAny> {
  if (!schema) {
    return {};
  }

  let effectiveSchema: Record<string, any> = schema as any;
  if (
    effectiveSchema instanceof z.ZodObject ||
    (typeof effectiveSchema === 'object' && '_def' in effectiveSchema && 'shape' in effectiveSchema)
  ) {
    effectiveSchema =
      typeof effectiveSchema.shape === 'function' ? effectiveSchema.shape() : effectiveSchema.shape;
  }

  const normalized: Record<string, z.ZodTypeAny> = {};
  const globalCoerce = options?.coerceInputs ?? false;

  for (const [key, val] of Object.entries(effectiveSchema)) {
    validateParameterName(key, toolName);

    if (typeof val === 'string') {
      const type = val.toLowerCase() as InputSchemaPropertyType;
      normalized[key] = globalCoerce
        ? buildCoercedZodSchema(type)
        : getBaseZodType(type);
    } else if (isInputSchemaPropertyConfig(val)) {
      const shouldCoerce = val.coerce !== undefined ? val.coerce : globalCoerce;
      let s: z.ZodTypeAny = shouldCoerce
        ? buildCoercedZodSchema(val.type)
        : getBaseZodType(val.type);

      if (val.default !== undefined) {
        s = s.default(val.default);
      } else if (val.required === false) {
        s = s.optional();
      }

      if (val.description) {
        s = s.describe(val.description);
      }

      normalized[key] = s;
    } else if (val && typeof val === 'object') {
      // Already a Zod schema or compatible schema
      if (globalCoerce && '_def' in val) {
        const typeName = (val as any)._def?.typeName;
        if (typeName === 'ZodNumber') {
          normalized[key] = z.preprocess(coerceNumber, val as z.ZodTypeAny);
        } else if (typeName === 'ZodBoolean') {
          normalized[key] = z.preprocess(coerceBoolean, val as z.ZodTypeAny);
        } else {
          normalized[key] = val as z.ZodTypeAny;
        }
      } else {
        normalized[key] = val as z.ZodTypeAny;
      }
    } else {
      normalized[key] = z.any();
    }
  }

  return normalized;
}

export interface RegisteredTool<TContext = unknown> extends ToolDefinition<any, TContext> {
  normalizedSchema: Record<string, z.ZodTypeAny>;
  compiledSchema?: z.ZodObject<any>;
  compiledCoerceSchema?: z.ZodObject<any>;
}

export class ToolRegistry<TContext = unknown> {
  private tools = new Map<string, RegisteredTool<TContext>>();
  private defaultCoerceInputs = false;

  constructor(options: { defaultCoerceInputs?: boolean } = {}) {
    this.defaultCoerceInputs = options.defaultCoerceInputs ?? false;
  }

  register(tool: ToolDefinition<any, TContext>): void {
    validateToolName(tool.name);
    const shouldCoerce =
      tool.coerceInputs !== undefined ? tool.coerceInputs : this.defaultCoerceInputs;
    const normalizedSchema = normalizeInputSchema(tool.inputSchema, tool.name, {
      coerceInputs: shouldCoerce
    });

    const hasProperties = Object.keys(normalizedSchema).length > 0;
    let compiledSchema: z.ZodObject<any> | undefined;
    let compiledCoerceSchema: z.ZodObject<any> | undefined;

    if (hasProperties) {
      const normalShape = normalizeInputSchema(tool.inputSchema, tool.name, { coerceInputs: false });
      const coerceShape = normalizeInputSchema(tool.inputSchema, tool.name, { coerceInputs: true });
      compiledSchema = z.object(normalShape);
      compiledCoerceSchema = z.object(coerceShape);
    }

    this.tools.set(tool.name, {
      ...tool,
      normalizedSchema,
      compiledSchema,
      compiledCoerceSchema
    });
  }

  get(name: string): RegisteredTool<TContext> | undefined {
    return this.tools.get(name);
  }

  getAll(): RegisteredTool<TContext>[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
