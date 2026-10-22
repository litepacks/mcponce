import { z } from 'zod';
import type { InputSchemaPropertyType } from '../types.js';

/**
 * Coerces stringified or scalar values into numbers if possible.
 */
export function coerceNumber(val: any): any {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed !== '' && !isNaN(Number(trimmed))) {
      return Number(trimmed);
    }
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  return val;
}

/**
 * Coerces stringified or numeric representations of booleans into boolean primitives.
 * Explicitly maps 'false', '0', 'no', 'off' to false (avoiding Boolean("false") === true bug).
 */
export function coerceBoolean(val: any): any {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') {
      return false;
    }
  }
  if (typeof val === 'number') {
    if (val === 1) return true;
    if (val === 0) return false;
  }
  return val;
}

/**
 * Coerces stringified JSON into an object if possible.
 */
export function coerceObject(val: any): any {
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    return val;
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return val;
}

/**
 * Coerces stringified JSON arrays, comma-separated lists, or single scalar values into arrays.
 */
export function coerceArray(val: any): any {
  if (Array.isArray(val)) {
    return val;
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
    if (val.includes(',')) {
      return val.split(',').map((s) => s.trim());
    }
    // If not JSON array, wrap single non-empty string as a single-element array
    return [val];
  }
  if (val !== undefined && val !== null) {
    return [val];
  }
  return val;
}

/**
 * Coerces numbers or booleans into strings.
 */
export function coerceString(val: any): any {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  return val;
}

/**
 * Coerces a single value based on target property type.
 */
export function smartCoerceValue(val: any, targetType: InputSchemaPropertyType | string): any {
  if (typeof targetType !== 'string') return val;

  const isOptional = targetType.endsWith('?');
  const cleanType = (isOptional ? targetType.slice(0, -1) : targetType).toLowerCase();

  if (isOptional && (val === undefined || val === null)) {
    return val;
  }

  switch (cleanType) {
    case 'number':
    case 'integer':
      return coerceNumber(val);
    case 'boolean':
      return coerceBoolean(val);
    case 'string':
      return coerceString(val);
    case 'object':
      return coerceObject(val);
    case 'array':
      return coerceArray(val);
    case 'string[]': {
      const arr = coerceArray(val);
      return Array.isArray(arr) ? arr.map(coerceString) : arr;
    }
    case 'number[]':
    case 'integer[]': {
      const arr = coerceArray(val);
      return Array.isArray(arr) ? arr.map(coerceNumber) : arr;
    }
    case 'boolean[]': {
      const arr = coerceArray(val);
      return Array.isArray(arr) ? arr.map(coerceBoolean) : arr;
    }
    default:
      return val;
  }
}

/**
 * Creates a Zod schema with built-in smart preprocessing coercion.
 * When serialized by MCP SDK's toJsonSchemaCompat, the underlying base type
 * is preserved for clean LLM tool advertising.
 */
export function buildCoercedZodSchema(
  type: InputSchemaPropertyType | string,
  baseSchema?: z.ZodTypeAny
): z.ZodTypeAny {
  const isOptional = typeof type === 'string' && type.endsWith('?');
  const cleanType = (isOptional ? type.slice(0, -1) : type).toLowerCase();

  let schema: z.ZodTypeAny;
  switch (cleanType) {
    case 'number':
    case 'integer':
      schema = z.preprocess(coerceNumber, baseSchema || z.number());
      break;
    case 'boolean':
      schema = z.preprocess(coerceBoolean, baseSchema || z.boolean());
      break;
    case 'string':
      schema = z.preprocess(coerceString, baseSchema || z.string());
      break;
    case 'object':
      schema = z.preprocess(coerceObject, baseSchema || z.record(z.any()));
      break;
    case 'array':
      schema = z.preprocess(coerceArray, baseSchema || z.array(z.any()));
      break;
    case 'string[]':
      schema = z.preprocess(
        (v) => {
          if (v === undefined || v === null) return v;
          const a = coerceArray(v);
          return Array.isArray(a) ? a.map(coerceString) : a;
        },
        baseSchema || z.array(z.string())
      );
      break;
    case 'number[]':
    case 'integer[]':
      schema = z.preprocess(
        (v) => {
          if (v === undefined || v === null) return v;
          const a = coerceArray(v);
          return Array.isArray(a) ? a.map(coerceNumber) : a;
        },
        baseSchema || z.array(z.number())
      );
      break;
    case 'boolean[]':
      schema = z.preprocess(
        (v) => {
          if (v === undefined || v === null) return v;
          const a = coerceArray(v);
          return Array.isArray(a) ? a.map(coerceBoolean) : a;
        },
        baseSchema || z.array(z.boolean())
      );
      break;
    default:
      schema = baseSchema || z.any();
      break;
  }

  return isOptional ? schema.optional() : schema;
}

/**
 * Dynamically coerces a record of arguments according to schema property types or Zod schemas.
 */
export function coerceArguments(
  args: Record<string, any>,
  inputSchema?: Record<string, any>
): Record<string, any> {
  if (!args || !inputSchema) return args || {};

  let effectiveProps: Record<string, any> = inputSchema;
  if (
    inputSchema instanceof z.ZodObject ||
    (typeof inputSchema === 'object' && '_def' in inputSchema && 'shape' in inputSchema)
  ) {
    effectiveProps =
      typeof (inputSchema as any).shape === 'function'
        ? (inputSchema as any).shape()
        : (inputSchema as any).shape;
  }

  const coerced: Record<string, any> = { ...args };

  for (const [key, val] of Object.entries(args)) {
    const propDef = effectiveProps[key];
    if (!propDef) continue;

    if (typeof propDef === 'string') {
      coerced[key] = smartCoerceValue(val, propDef.toLowerCase() as InputSchemaPropertyType);
    } else if (typeof propDef === 'object' && propDef !== null) {
      if (typeof propDef.type === 'string') {
        coerced[key] = smartCoerceValue(val, propDef.type.toLowerCase() as InputSchemaPropertyType);
      } else if ('_def' in propDef) {
        let currentDef = propDef;
        while (currentDef?._def?.innerType) {
          currentDef = currentDef._def.innerType;
        }
        const typeName = currentDef._def?.typeName;
        if (typeName === 'ZodNumber') {
          coerced[key] = coerceNumber(val);
        } else if (typeName === 'ZodBoolean') {
          coerced[key] = coerceBoolean(val);
        } else if (typeName === 'ZodString') {
          coerced[key] = coerceString(val);
        } else if (typeName === 'ZodArray') {
          const arr = coerceArray(val);
          let inner = currentDef._def?.type;
          while (inner?._def?.innerType) {
            inner = inner._def.innerType;
          }
          const innerType = inner?._def?.typeName;
          if (innerType === 'ZodNumber') {
            coerced[key] = Array.isArray(arr) ? arr.map(coerceNumber) : arr;
          } else if (innerType === 'ZodBoolean') {
            coerced[key] = Array.isArray(arr) ? arr.map(coerceBoolean) : arr;
          } else if (innerType === 'ZodString') {
            coerced[key] = Array.isArray(arr) ? arr.map(coerceString) : arr;
          } else {
            coerced[key] = arr;
          }
        } else if (typeName === 'ZodObject' || typeName === 'ZodRecord') {
          coerced[key] = coerceObject(val);
        }
      }
    }
  }

  return coerced;
}
