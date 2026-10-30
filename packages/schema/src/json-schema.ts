// A clyops schema as a JSON Schema for the input `toArgv` takes: what an API
// body or an MCP tool's arguments look like.
import { inputKey, isBareFlag } from './names.js';
import type { Schema, SchemaArgument, SchemaOption } from './types.js';

/** A JSON Schema object describing accepted tool input. */
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
    case 'json':
      // Any JSON value: toArgv passes a string as its JSON text, anything else serialized.
      return { contentMediaType: JSON_TYPE };
    default:
      return { type: 'string' };
  }
}

/** A default as the JSON value the schema describes (`"3"` -> 3, a `json` default parsed). */
function typedDefault(value: string, schema: JsonSchema): unknown {
  if (schema.type === 'integer' || schema.type === 'number') return Number(value);
  if (schema.type === 'boolean') return /^(true|1|yes|on)$/i.test(value);
  if (schema.contentMediaType === JSON_TYPE) {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

const JSON_TYPE = 'application/json';

// A JSON Pointer token (RFC 6901).
const token = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * A tool's `json:SCHEMA` schema placed at `pointer` in the input's schema
 * (spec section 13): `$schema` and `$id` removed (two tools may share one
 * schema), `#` references pointed at its new place, and other references,
 * not fetched by then (clyops-tools' loadTools fetches them into `$defs`), kept only as a `$comment`.
 */
function embedSchema(schema: unknown, pointer: string): JsonSchema {
  if (schema === true || schema === null || schema === undefined) return {};
  if (schema === false) return { not: {} };
  if (typeof schema !== 'object' || Array.isArray(schema)) return {};
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        if (v.startsWith('#')) out.$ref = pointer + v.slice(1);
        else out.$comment = `JSON Schema: ${v}`;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };
  const { $schema: _schema, $id: _id, ...rest } = walk(schema) as JsonSchema;
  return rest;
}

function property(item: SchemaOption | SchemaArgument, many: boolean, flag: boolean, pointer: string): JsonSchema {
  const rule = valueSchema(item.validation, 'choices' in item ? item.choices : []);
  const value = flag
    ? { type: 'boolean' }
    : item.validation.startsWith('json:') && item.schema !== undefined && item.schema !== null
      ? { ...embedSchema(item.schema, many ? `${pointer}/items` : pointer), contentMediaType: JSON_TYPE }
      : rule;
  const out: JsonSchema = many ? { type: 'array', items: value } : { ...value };
  if (item.description) out.description = item.description;
  if (item.default !== '' && !many && !('secret' in item && item.secret)) out.default = typedDefault(item.default, value);
  if ('secret' in item && item.secret) Object.assign(out, { writeOnly: true, format: 'password' });
  return out;
}

/**
 * Input keys are `inputKey(name)` for options and arguments. Required arguments
 * are required; a required option is not, since the tool may also get it from
 * its environment or a config file (and says so when it doesn't).
 */
export function toJsonSchema(schema: Schema, naming: 'input' | 'declared' = 'input'): JsonSchema {
  const key = naming === 'input' ? inputKey : (name: string) => name;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const argument of schema.arguments) {
    properties[key(argument.name)] = property(argument, argument.isVariadic, false, `#/properties/${token(key(argument.name))}`);
    if (argument.required) required.push(key(argument.name));
  }
  for (const option of schema.options) {
    if (option.name === 'help') continue;
    properties[key(option.name)] = property(option, option.isArray, isBareFlag(option), `#/properties/${token(key(option.name))}`);
  }
  // Exclusive options can't both be given (spec section 1.6). The other
  // relationships are left to the tool: like required options, they may be
  // satisfied by its config file or environment.
  const given = (long: string): JsonSchema => {
    const option = schema.options.find((o) => o.name === long);
    if (option && !option.isArray && (isBareFlag(option) || valueSchema(option.validation, option.choices).type === 'boolean')) return { const: true };
    if (option && !option.isArray && [...option.choices].sort().join(',') === 'false,true') return { const: 'true' };
    return option?.isArray ? { type: 'array', minItems: 1 } : { not: { type: 'null' } };
  };
  const allOf: JsonSchema[] = [];
  for (const c of schema.constraints ?? []) {
    if (c.type !== 'exclusive') continue;
    for (let i = 0; i < c.options.length; i++) {
      for (let j = i + 1; j < c.options.length; j++) {
        const [a, b] = [c.options[i], c.options[j]];
        allOf.push({
          not: { required: [key(a), key(b)], properties: { [key(a)]: given(a), [key(b)]: given(b) } },
          description: `--${a} and --${b} cannot be used together`,
        });
      }
    }
  }
  return {
    type: 'object',
    ...(schema.description ? { description: schema.description } : {}),
    properties,
    ...(required.length ? { required } : {}),
    ...(allOf.length ? { allOf } : {}),
    additionalProperties: false,
  };
}

/**
 * `input` with each `json` value given as a string parsed (spec section 13),
 * for validating against `inputSchema` (from toJsonSchema): a string is the
 * JSON text, so its value is what the schema checks. Run the tool with the
 * original input, which keeps the text as given. A string that isn't JSON is
 * an error naming the key.
 */
export function parseJsonInputs(inputSchema: JsonSchema, input: Record<string, unknown>): { value: Record<string, unknown> } | { error: string } {
  const properties = (inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const value: Record<string, unknown> = { ...input };
  for (const [key, prop] of Object.entries(properties)) {
    const many = prop.type === 'array' && (prop.items as JsonSchema | undefined)?.contentMediaType === JSON_TYPE;
    if (!(key in value) || (prop.contentMediaType !== JSON_TYPE && !many)) continue;
    const parse = (v: unknown): unknown => {
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { throw new Error(`${key} must be valid JSON`); }
    };
    try {
      value[key] = many && Array.isArray(value[key]) ? (value[key] as unknown[]).map(parse) : parse(value[key]);
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  return { value };
}

/**
 * `inputSchema` (from toJsonSchema) with each `json` input whose schema `compile` rejects (e.g.
 * ajv's, for a `$ref` to nothing or an unknown `type`) left unchecked, as one that can't be fetched
 * is: any JSON, keeping its description and default. Each one goes to `onError` with its key, so
 * one broken schema doesn't fail every call to the tool.
 */
export function checkableInputSchema(inputSchema: JsonSchema, compile: (schema: JsonSchema) => unknown, onError: (key: string, err: Error) => void = () => {}): JsonSchema {
  const properties = (inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  let out: Record<string, JsonSchema> | undefined;
  for (const [key, prop] of Object.entries(properties)) {
    const many = prop.type === 'array' && (prop.items as JsonSchema | undefined)?.contentMediaType === JSON_TYPE;
    if (prop.contentMediaType !== JSON_TYPE && !many) continue;
    try {
      // Alone at its own key, so its `#/properties/<key>/...` references still resolve.
      compile({ type: 'object', properties: { [key]: prop } });
    } catch (err) {
      onError(key, err as Error);
      const unchecked = (schema: JsonSchema) => Object.fromEntries(Object.entries(schema).filter(([k]) => ['contentMediaType', 'description', 'default', 'writeOnly', 'format'].includes(k)));
      out ??= { ...properties };
      out[key] = many ? { ...prop, items: unchecked(prop.items as JsonSchema) } : unchecked(prop);
    }
  }
  return out ? { ...inputSchema, properties: out } : inputSchema;
}
