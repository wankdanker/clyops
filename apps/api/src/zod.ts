// The JSON Schema from clyops-tools' toJsonSchema as a zod schema, so
// plus-express validates request bodies and documents them in OpenAPI from
// the same source the MCP server uses.
import type { JsonSchema } from 'clyops-tools';
import { z } from 'plus-express';

type Js = JsonSchema & {
  type?: string; enum?: string[]; pattern?: string; items?: Js; description?: string; default?: unknown;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  properties?: Record<string, Js>; required?: string[];
};

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
