// A clyops schema as a JSON Schema for the input `toArgv` takes: what an API
// body or an MCP tool's arguments look like.
import { inputKey, isBareFlag } from './argv.js';
import type { Schema, SchemaArgument, SchemaOption } from './schema.js';

export type JsonSchema = { [key: string]: unknown };

// The exact patterns from spec section 5.
const PATTERNS: Record<string, string> = {
  ip: '^([0-9]{1,3}\\.){3}[0-9]{1,3}$|^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$',
  hostname: '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$',
  url: '^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$',
  email: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  'date:YYYY-MM-DD': '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
};

/** `MIN-MAX`, `MIN-`, `-MAX` or `N` (exactly N, for `string:N`). */
function bounds(spec: string, min: string, max: string): JsonSchema {
  const m = /^([0-9.]*)-([0-9.]*)$/.exec(spec);
  if (!m) return spec ? { [min]: Number(spec), [max]: Number(spec) } : {};
  return { ...(m[1] ? { [min]: Number(m[1]) } : {}), ...(m[2] ? { [max]: Number(m[2]) } : {}) };
}

/** The JSON Schema of one value validated by `validation`. */
export function valueSchema(validation: string, choices: string[] = []): JsonSchema {
  const [rule, spec = ''] = validation.split(/:(.*)/s);
  if (validation in PATTERNS) return { type: 'string', pattern: PATTERNS[validation] };
  switch (rule) {
    case 'int':
      return { type: 'integer', ...bounds(spec, 'minimum', 'maximum') };
    case 'float':
      return { type: 'number', ...bounds(spec, 'minimum', 'maximum') };
    case 'port':
      return { type: 'integer', minimum: 1, maximum: 65535 };
    case 'bool':
      return { type: 'boolean' };
    case 'string':
      return { type: 'string', ...bounds(spec, 'minLength', 'maxLength') };
    case 'choice':
      return { type: 'string', enum: choices.length ? choices : spec.split(',') };
    case 'regex':
      return { type: 'string', pattern: spec };
    default:
      return { type: 'string' };
  }
}

/** A default as the JSON value the schema describes (`"3"` -> 3). */
function typedDefault(value: string, schema: JsonSchema): unknown {
  if (schema.type === 'integer' || schema.type === 'number') return Number(value);
  if (schema.type === 'boolean') return /^(true|1|yes|on)$/i.test(value);
  return value;
}

function property(item: SchemaOption | SchemaArgument, many: boolean, flag: boolean): JsonSchema {
  const value = flag ? { type: 'boolean' } : valueSchema(item.validation, 'choices' in item ? item.choices : []);
  const out: JsonSchema = many ? { type: 'array', items: value } : { ...value };
  if (item.description) out.description = item.description;
  if (item.default !== '' && !many) out.default = typedDefault(item.default, value);
  return out;
}

/**
 * Input keys are `inputKey(name)` for options and arguments. Required arguments
 * are required; a required option is not, since the tool may also get it from
 * its environment or a config file (and says so when it doesn't).
 */
export function toJsonSchema(schema: Schema): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const argument of schema.arguments) {
    properties[inputKey(argument.name)] = property(argument, argument.isVariadic, false);
    if (argument.required) required.push(inputKey(argument.name));
  }
  for (const option of schema.options) {
    if (option.name === 'help') continue;
    properties[inputKey(option.name)] = property(option, option.isArray, isBareFlag(option));
  }
  return {
    type: 'object',
    ...(schema.description ? { description: schema.description } : {}),
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
