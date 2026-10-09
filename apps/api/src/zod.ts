// The JSON Schema from clyops-tools' toJsonSchema as a zod schema, so
// plus-express validates request bodies and documents them in OpenAPI from
// the same source the MCP server uses.
import type { JsonSchema } from 'clyops-tools';
import { z } from 'plus-express';

type Js = JsonSchema & {
  type?: string; enum?: string[]; pattern?: string; items?: Js; description?: string; default?: unknown;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  properties?: Record<string, Js>; required?: string[];
  allOf?: { not?: { required?: string[]; properties?: Record<string, Js & { const?: unknown; not?: unknown }> }; description?: string }[];
};

/** Whether `value` matches one of the "given" shapes toJsonSchema uses for exclusive options. */
function given(value: unknown, shape: { const?: unknown; type?: string; minItems?: number; not?: unknown } | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (!shape) return true;
  if ('const' in shape) return value === shape.const;
  if (shape.type === 'array') return Array.isArray(value) && value.length >= (shape.minItems ?? 0);
  return true;
}

export function toZod(schema: Js): z.ZodType {
  let out: z.ZodType;
  switch (schema.type) {
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
      out = z.array(toZod(schema.items ?? {}));
      break;
    case 'object': {
      const required = new Set(schema.required ?? []);
      const shape = Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, prop]) => [key, required.has(key) ? toZod(prop) : toZod(prop).optional()]),
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
  return Object.keys(meta).length ? out.openapi(meta) : out;
}
