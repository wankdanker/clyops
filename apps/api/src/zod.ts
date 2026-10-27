// The JSON Schema from clyops-tools' toJsonSchema as a zod schema, so
// plus-express validates request bodies and documents them in OpenAPI from
// the same source the MCP server uses.
import { Ajv, type ValidateFunction } from 'ajv';
import type { JsonSchema } from 'clyops-tools';
import { z } from 'plus-express';

type Js = JsonSchema & {
  type?: string; enum?: string[]; pattern?: string; items?: Js; description?: string; default?: unknown;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  properties?: Record<string, Js>; required?: string[];
  allOf?: { not?: { required?: string[]; properties?: Record<string, Js & { const?: unknown; not?: unknown }> }; description?: string }[];
  contentMediaType?: string;
};

// Where a property sits in the input's schema, which json inputs are validated against.
interface At { root: Js; pointer: string }

// A JSON Pointer token (RFC 6901).
const token = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

// The input schemas json inputs are checked against, compiled once each: a
// json:SCHEMA schema's own `#` references point into the whole input schema.
const compiled = new WeakMap<Js, { ajv: Ajv; id: string }>();
let schemas = 0;
function validator(at: At): ValidateFunction {
  let entry = compiled.get(at.root);
  if (!entry) {
    entry = { ajv: new Ajv({ strict: false, validateFormats: false, validateSchema: false, allErrors: true }), id: `clyops-input-${++schemas}` };
    entry.ajv.addSchema(at.root, entry.id);
    compiled.set(at.root, entry);
  }
  return entry.ajv.getSchema(`${entry.id}#${at.pointer}`) as ValidateFunction;
}

// Keywords that only document a json input; anything else is a schema to check.
const DOCUMENTATION = new Set(['contentMediaType', 'description', 'default', 'writeOnly', 'format']);

/**
 * A json input (spec section 13): any JSON value, a string being its JSON
 * text, whose value must match the tool's schema when it has one.
 */
function jsonValue(schema: Js, at: At): z.ZodType {
  const checked = Object.keys(schema).some((k) => !DOCUMENTATION.has(k));
  return z.unknown().superRefine((input, ctx) => {
    let value = input;
    if (typeof input === 'string') {
      try {
        value = JSON.parse(input);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
        return;
      }
    }
    if (!checked) return;
    const validate = validator(at);
    if (validate(value)) return;
    for (const e of validate.errors ?? []) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: [e.instancePath, e.message].filter(Boolean).join(' ') });
    }
  });
}

/**
 * A json input's schema for its OpenAPI `x-clyops-json-schema`, standing on its own: without the
 * keywords that only document it, and with the `#` references that point into the whole input
 * schema (`#/properties/shape/$defs/x`) pointing into itself (`#/$defs/x`). OpenAPI 3.0 schema
 * objects are a subset of JSON Schema, so the full schema goes in an extension.
 */
function selfContained(schema: Js, pointer: string): unknown {
  const prefix = `#${pointer}`;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && (v === prefix || v.startsWith(`${prefix}/`)) ? `#${v.slice(prefix.length)}` : walk(v)]));
  };
  return walk(Object.fromEntries(Object.entries(schema).filter(([k]) => !DOCUMENTATION.has(k))));
}

/** Whether `value` matches one of the "given" shapes toJsonSchema uses for exclusive options. */
function given(value: unknown, shape: { const?: unknown; type?: string; minItems?: number; not?: unknown } | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (!shape) return true;
  if ('const' in shape) return value === shape.const;
  if (shape.type === 'array') return Array.isArray(value) && value.length >= (shape.minItems ?? 0);
  return true;
}

/** Convert a tool input JSON Schema to a Zod validator used by HTTP routes. */
export function toZod(schema: Js, at: At = { root: schema, pointer: '' }): z.ZodType {
  let out: z.ZodType;
  switch (schema.contentMediaType === 'application/json' ? 'json' : schema.type) {
    case 'json':
      out = jsonValue(schema, at);
      break;
    case 'integer':
    case 'number': {
      let n = schema.type === 'integer' ? z.number().int() : z.number();
      if (schema.minimum !== undefined) n = n.min(schema.minimum);
      if (schema.maximum !== undefined) n = n.max(schema.maximum);
      out = n;
      break;
    }
    case 'boolean':
      out = z.boolean();
      break;
    case 'array':
      out = z.array(toZod(schema.items ?? {}, { root: at.root, pointer: `${at.pointer}/items` }));
      break;
    case 'object': {
      const required = new Set(schema.required ?? []);
      const shape = Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, prop]) => {
          const value = toZod(prop, { root: at.root, pointer: `${at.pointer}/properties/${token(key)}` });
          return [key, required.has(key) ? value : value.optional()];
        }),
      );
      out = z.strictObject(shape);
      // Exclusive options (allOf: [{ not: { required: [a, b] } }]) can't both be given.
      const exclusive = (schema.allOf ?? []).filter((c) => c.not?.required?.length);
      if (exclusive.length) {
        out = out.superRefine((value, ctx) => {
          const input = value as Record<string, unknown>;
          for (const c of exclusive) {
            const keys = c.not?.required ?? [];
            if (keys.every((k) => given(input[k], c.not?.properties?.[k]))) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [keys[keys.length - 1]], message: c.description ?? `${keys.join(' and ')} cannot be used together` });
            }
          }
        });
      }
      break;
    }
    default: {
      if (schema.enum) {
        out = z.enum(schema.enum as [string, ...string[]]);
        break;
      }
      let s = z.string();
      if (schema.minLength !== undefined) s = s.min(schema.minLength);
      if (schema.maxLength !== undefined) s = s.max(schema.maxLength);
      if (schema.pattern) s = s.regex(new RegExp(schema.pattern));
      out = s;
    }
  }
  // Defaults are documentation only: the tool applies its own, so a value it
  // would get from its config file or environment is not overridden.
  const meta: Record<string, unknown> = {};
  if (schema.description) meta.description = schema.description;
  if (schema.default !== undefined) meta.default = schema.default;
  if (schema.contentMediaType === 'application/json' && Object.keys(schema).some((k) => !DOCUMENTATION.has(k))) {
    meta['x-clyops-json-schema'] = selfContained(schema, at.pointer);
  }
  return Object.keys(meta).length ? out.openapi(meta) : out;
}
