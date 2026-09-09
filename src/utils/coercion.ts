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
 * Coerces stringified JSON arrays or single scalar values into arrays.
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
export function smartCoerceValue(val: any, targetType: InputSchemaPropertyType): any {
  switch (targetType) {
    case 'number':
      return coerceNumber(val);
    case 'boolean':
      return coerceBoolean(val);
    case 'string':
      return coerceString(val);
    case 'object':
      return coerceObject(val);
    case 'array':
      return coerceArray(val);
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
  type: InputSchemaPropertyType,
  baseSchema?: z.ZodTypeAny
): z.ZodTypeAny {
  switch (type) {
    case 'number':
      return z.preprocess(coerceNumber, baseSchema || z.number());
    case 'boolean':
      return z.preprocess(coerceBoolean, baseSchema || z.boolean());
    case 'string':
      return z.preprocess(coerceString, baseSchema || z.string());
    case 'object':
      return z.preprocess(coerceObject, baseSchema || z.record(z.any()));
    case 'array':
      return z.preprocess(coerceArray, baseSchema || z.array(z.any()));
    default:
      return baseSchema || z.any();
  }
}

/**
 * Dynamically coerces a record of arguments according to schema property types or Zod schemas.
 */
export function coerceArguments(
  args: Record<string, any>,
  inputSchema?: Record<string, any>
): Record<string, any> {
  if (!args || !inputSchema) return args || {};

  const coerced: Record<string, any> = { ...args };

  for (const [key, val] of Object.entries(args)) {
    const propDef = inputSchema[key];
    if (!propDef) continue;

    if (typeof propDef === 'string') {
      coerced[key] = smartCoerceValue(val, propDef.toLowerCase() as InputSchemaPropertyType);
    } else if (typeof propDef === 'object' && propDef !== null) {
      if (typeof propDef.type === 'string') {
        coerced[key] = smartCoerceValue(val, propDef.type.toLowerCase() as InputSchemaPropertyType);
      } else if ('_def' in propDef) {
        const typeName = propDef._def?.typeName;
        if (typeName === 'ZodNumber') {
          coerced[key] = coerceNumber(val);
        } else if (typeName === 'ZodBoolean') {
          coerced[key] = coerceBoolean(val);
        } else if (typeName === 'ZodString') {
          coerced[key] = coerceString(val);
        } else if (typeName === 'ZodArray') {
          coerced[key] = coerceArray(val);
        } else if (typeName === 'ZodObject' || typeName === 'ZodRecord') {
          coerced[key] = coerceObject(val);
        }
      }
    }
  }

  return coerced;
}
