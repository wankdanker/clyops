import { inputKey, isBareFlag } from './names.js';
import { parseJsonInputs, toJsonSchema, type JsonSchema } from './json-schema.js';
import type { Schema, SchemaConstraint, SchemaOption } from './types.js';

/** A scalar value's JSON Schema properties used by form controls. */
export interface ValueSpec {
  /** JSON value type, including arrays. */
  type?: string;
  /** Permitted enum values. */
  enum?: string[];
  /** Smallest numeric value. */
  minimum?: number;
  /** Largest numeric value. */
  maximum?: number;
  /** Minimum string length. */
  minLength?: number;
  /** Maximum string length. */
  maxLength?: number;
  /** String validation expression. */
  pattern?: string;
  /** Declared default; presentation only, never automatically submitted. */
  default?: unknown;
  /** Array element schema. */
  items?: ValueSpec;
}

/** Framework-independent description of one input and its control. */
export interface FormField {
  /** Input key, normalized for REST/MCP or retained for desktop templates. */
  key: string;
  /** Registered argument or long option name. */
  name: string;
  /** Human-readable field explanation. */
  description: string;
  /** Display group, or Arguments for positionals. */
  group: string;
  /** Whether this is a positional argument. */
  positional: boolean;
  /** Whether the tool requires a value; options may inherit config/environment values. */
  required: boolean;
  /** Whether values repeat. */
  many: boolean;
  /** Whether values must be kept out of templates and previews. */
  secret: boolean;
  /** Whether this accepts a path on the server's filesystem. */
  path: boolean;
  /** Whether its value is JSON text (`json` or `json:SCHEMA`), checked against `schema` once parsed. */
  json: boolean;
  /** Original rule for explanations and server-only checks. */
  validation: string;
  /** Converted JSON Schema of the submitted field. */
  schema: ValueSpec;
}

/** Build fields from the same JSON Schema used by the API and MCP validators. */
export function formFields(schema: Schema, naming: 'input' | 'declared' = 'input'): FormField[] {
  const properties = toJsonSchema(schema, naming).properties as Record<string, ValueSpec>;
  return [
    ...schema.arguments.map(arg => ({ ...arg, positional: true, group: 'Arguments', many: arg.isVariadic, secret: false, valueType: '' })),
    ...schema.options.filter(opt => opt.name !== 'help').map(opt => ({ ...opt, positional: false, many: opt.isArray, secret: !!opt.secret, valueType: opt.type })),
  ].map(item => {
    const key = naming === 'input' ? inputKey(item.name) : item.name;
    return {
      key, name: item.name, description: item.description, group: item.group,
      positional: item.positional, required: item.required, many: item.many, secret: item.secret,
      path: item.valueType === 'path' || /^(path|file:|dir:)/.test(item.validation),
      json: item.validation === 'json' || item.validation.startsWith('json:'),
      validation: item.validation, schema: properties[key],
    };
  });
}

/** A compiled JSON Schema validator in ajv's shape: true when valid, else its `errors`. */
export interface InputValidator {
  (data: unknown): boolean;
  /** The last call's errors. */
  errors?: { /** JSON Pointer to the value. */ instancePath: string; message?: string; /** Keyword details, e.g. `missingProperty`. */ params: Record<string, unknown> }[] | null;
}

/**
 * The problems with supplied inputs against their input schema (from toJsonSchema), using a
 * validator compiled from it (e.g. ajv's), so this package stays free of dependencies. A `json`
 * field's text is parsed first, as servers do (spec section 13), so its value is what its schema
 * checks, each field on its own so one that isn't JSON doesn't hide the others: `shape: /w must be
 * integer`, `shape: must be valid JSON`.
 */
export function inputIssues(inputSchema: JsonSchema, input: Record<string, unknown>, validate: InputValidator): string[] {
  const issues: string[] = [];
  const parsed: Record<string, unknown> = {};
  const unparsed = new Set<string>();
  for (const [key, value] of Object.entries(input)) {
    const one = parseJsonInputs(inputSchema, { [key]: value });
    if ('error' in one) { issues.push(`${key}: must be valid JSON`); unparsed.add(key); } else parsed[key] = one.value[key];
  }
  if (validate(parsed)) return issues;
  for (const error of validate.errors ?? []) {
    const [key = '', ...rest] = error.instancePath.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const missing = error.params.missingProperty as string | undefined;
    if (missing && !key && unparsed.has(missing)) continue;
    issues.push(`${key || missing || 'Input'}: ${rest.length ? `/${rest.join('/')} ` : ''}${error.message ?? 'is invalid'}`);
  }
  return issues;
}

/** A `json` field's schema as shown to people: what it checks, without the form's own annotations. */
export function jsonSchemaView(field: FormField): string | undefined {
  if (!field.json) return undefined;
  const { contentMediaType: _type, description: _description, default: _default, ...rest } = (field.many ? field.schema.items ?? {} : field.schema) as Record<string, unknown>;
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : undefined;
}

/** The text a `json` field starts with when it is enabled, or shows as a hint: its default, else its first example. */
export function jsonSample(field: FormField): string {
  const schema = (field.many ? field.schema.items ?? {} : field.schema) as { default?: unknown; examples?: unknown[] };
  const sample = schema.default !== undefined ? schema.default : Array.isArray(schema.examples) ? schema.examples[0] : undefined;
  return sample === undefined ? '' : JSON.stringify(sample, null, 2);
}

/** An input conflict or an unresolved requirement that the tool may satisfy from config/environment. */
export interface ConstraintIssue {
  /** Hard conflicts block submission; unresolved requirements are advisory. */
  severity: 'error' | 'notice';
  /** Relationship that produced this issue. */
  constraint: SchemaConstraint;
  /** Human-readable explanation, including inheritance when applicable. */
  message: string;
}

/** Whether an explicitly supplied option counts as given under spec section 1.6. */
export function optionGiven(option: SchemaOption, value: unknown): boolean {
  if (value === undefined || value === null || value === false || (Array.isArray(value) && !value.length)) return false;
  const boolean = isBareFlag(option) || option.validation === 'bool' || [...option.choices].sort().join(',') === 'false,true';
  return !(boolean && typeof value === 'string' && /^(false|0|no|off)$/i.test(value));
}

/** Check explicit overrides; required values may still be inherited by the actual tool. */
export function constraintIssues(schema: Schema, input: Record<string, unknown>, naming: 'input' | 'declared' = 'input'): ConstraintIssue[] {
  const given = (name: string) => {
    const option = schema.options.find(opt => opt.name === name);
    return !!option && optionGiven(option, input[naming === 'input' ? inputKey(name) : name]);
  };
  const list = (names: string[]) => names.map(name => `--${name}`).join(', ');
  const issues: ConstraintIssue[] = [];
  for (const constraint of schema.constraints ?? []) {
    const selected = constraint.options.filter(given);
    if (constraint.type === 'exclusive' && selected.length > 1) issues.push({ severity: 'error', constraint, message: `${list(selected)} cannot be used together.` });
    if (constraint.type === 'requires' && given(constraint.options[0])) {
      const missing = constraint.options.slice(1).filter(name => !given(name));
      if (missing.length) issues.push({ severity: 'notice', constraint, message: `${list([constraint.options[0]])} requires ${list(missing)}. The tool may inherit these from config or environment.` });
    }
    if (constraint.type === 'oneOf' && !selected.length) issues.push({ severity: 'notice', constraint, message: `At least one of ${list(constraint.options)} must be supplied or inherited from config/environment. Defaults do not count.` });
  }
  return issues;
}

/** Remove secret fields from a saved template or displayed input preview. */
export function withoutSecrets(schema: Schema, input: Record<string, unknown>, naming: 'input' | 'declared' = 'input'): Record<string, unknown> {
  const secrets = new Set(schema.options.filter(opt => opt.secret).flatMap(opt => [inputKey(opt.name), opt.name, opt.variableName.toLowerCase()]));
  // Keep only declared keys; unknown aliases must never bypass redaction.
  const known = new Set(formFields(schema, naming).filter(field => !field.secret).map(field => field.key));
  return Object.fromEntries(Object.entries(input).filter(([key]) => known.has(key) && !secrets.has(key)));
}

/** Treat undeclared, JSON, XML and text MIME types as textual streams. */
export function isTextType(contentType = ''): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return !type || type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type === 'application/xml';
}

/** Attach relationship and execution metadata without changing request-validation semantics. */
export function formSchema(schema: Schema): JsonSchema {
  return { ...toJsonSchema(schema), 'x-clyops': { constraints: schema.constraints ?? [], effects: schema.effects ?? [], stdin: schema.stdin ?? null, stdout: schema.stdout ?? null, roles: schema.roles ?? [] } };
}
