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
  coerceBoolean,
  coerceArray,
  coerceString
} from '../utils/coercion.js';

function getBaseZodType(type: InputSchemaPropertyType | string): z.ZodTypeAny {
  const isOptional = typeof type === 'string' && type.endsWith('?');
  const cleanType = (isOptional ? type.slice(0, -1) : type).toLowerCase();

  let base: z.ZodTypeAny;
  switch (cleanType) {
    case 'string':
      base = z.string();
      break;
    case 'number':
    case 'integer':
      base = z.number();
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'array':
      base = z.array(z.any());
      break;
    case 'object':
      base = z.record(z.any());
      break;
    case 'string[]':
      base = z.array(z.string());
      break;
    case 'number[]':
    case 'integer[]':
      base = z.array(z.number());
      break;
    case 'boolean[]':
      base = z.array(z.boolean());
      break;
    default:
      base = z.any();
      break;
  }

  return isOptional ? base.optional() : base;
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
      const isOptional = val.endsWith('?');
      const cleanType = isOptional ? val.slice(0, -1).toLowerCase() : val.toLowerCase();
      let schema: z.ZodTypeAny = globalCoerce
        ? buildCoercedZodSchema(cleanType)
        : getBaseZodType(cleanType);
      if (isOptional) {
        schema = schema.optional();
      }
      normalized[key] = schema;
    } else if (isInputSchemaPropertyConfig(val)) {
      const isOptional = val.type.endsWith('?') || val.required === false;
      const cleanType = val.type.endsWith('?') ? val.type.slice(0, -1).toLowerCase() : val.type.toLowerCase();
      const shouldCoerce = val.coerce !== undefined ? val.coerce : globalCoerce;
      let s: z.ZodTypeAny = shouldCoerce
        ? buildCoercedZodSchema(cleanType)
        : getBaseZodType(cleanType);

      if (val.default !== undefined) {
        s = s.default(val.default);
      } else if (isOptional) {
        s = s.optional();
      }

      if (val.description) {
        s = s.describe(val.description);
      }

      normalized[key] = s;
    } else if (val && typeof val === 'object') {
      // Already a Zod schema or compatible schema
      if (globalCoerce && '_def' in val) {
        let currentDef = val as any;
        while (currentDef?._def?.innerType) {
          currentDef = currentDef._def.innerType;
        }
        const typeName = currentDef._def?.typeName;
        if (typeName === 'ZodNumber') {
          normalized[key] = z.preprocess(coerceNumber, val as z.ZodTypeAny);
        } else if (typeName === 'ZodBoolean') {
          normalized[key] = z.preprocess(coerceBoolean, val as z.ZodTypeAny);
        } else if (typeName === 'ZodArray') {
          let inner = currentDef._def?.type;
          while (inner?._def?.innerType) {
            inner = inner._def.innerType;
          }
          const innerTypeName = inner?._def?.typeName;
          if (innerTypeName === 'ZodNumber') {
            normalized[key] = z.preprocess(
              (v) => {
                if (v === undefined || v === null) return v;
                const a = coerceArray(v);
                return Array.isArray(a) ? a.map(coerceNumber) : a;
              },
              val as z.ZodTypeAny
            );
          } else if (innerTypeName === 'ZodBoolean') {
            normalized[key] = z.preprocess(
              (v) => {
                if (v === undefined || v === null) return v;
                const a = coerceArray(v);
                return Array.isArray(a) ? a.map(coerceBoolean) : a;
              },
              val as z.ZodTypeAny
            );
          } else if (innerTypeName === 'ZodString') {
            normalized[key] = z.preprocess(
              (v) => {
                if (v === undefined || v === null) return v;
                const a = coerceArray(v);
                return Array.isArray(a) ? a.map(coerceString) : a;
              },
              val as z.ZodTypeAny
            );
          } else {
            normalized[key] = z.preprocess(
              (v) => (v === undefined || v === null ? v : coerceArray(v)),
              val as z.ZodTypeAny
            );
          }
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

  register(tool: ToolDefinition<any, TContext>): RegisteredTool<TContext> {
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

    const registered: RegisteredTool<TContext> = {
      ...tool,
      normalizedSchema,
      compiledSchema,
      compiledCoerceSchema
    };

    this.tools.set(tool.name, registered);
    return registered;
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
