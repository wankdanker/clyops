import Ajv, { type ValidateFunction } from 'ajv';
import { checkableInputSchema, formFields, inputIssues, jsonSample, jsonSchemaView, withoutSecrets, type JsonSchema, type Schema, type ValueSpec, type FormField } from 'clyops-schema';

const ajv = new Ajv({ allErrors: true, strict: false });
// The form checks on every change; compile each tool's input schema once.
const validators = new WeakMap<object, { input: JsonSchema; validate: ValidateFunction }>();

/** Convert a scalar control's text without turning an empty numeric input into zero. */
export function controlValue(value: string, schema: ValueSpec): unknown {
  if (schema.type === 'integer' || schema.type === 'number') return value === '' ? '' : Number(value);
  if (schema.type === 'boolean') return value === 'true';
  return value;
}

/** Control attributes follow the generated schema for both scalars and array elements. */
export function controlAttributes(field: FormField) {
  const value = field.many ? field.schema.items ?? {} : field.schema;
  return {
    // A json value is text, whatever type its schema checks once it is parsed.
    type: field.secret ? 'password' : field.json ? 'text' : value.type === 'integer' || value.type === 'number' ? 'number' : field.validation === 'date:YYYY-MM-DD' ? 'date' : 'text',
    ...(field.json ? {} : { min: value.minimum, max: value.maximum, step: value.type === 'integer' ? 1 : 'any', minlength: value.minLength, maxlength: value.maxLength }),
  };
}

/** Validate only supplied inputs (see clyops-schema's inputIssues); the tool resolves inheritance and remaining requirements. */
export function inputErrors(inputSchema: object, input: Record<string, unknown>): string[] {
  let entry = validators.get(inputSchema);
  if (!entry) {
    // The API serves a json input whose schema doesn't compile unchecked; so does the form.
    const checkable = checkableInputSchema(inputSchema as JsonSchema, (schema) => new Ajv({ strict: false }).compile(schema));
    validators.set(inputSchema, (entry = { input: checkable, validate: ajv.compile(checkable) }));
  }
  return inputIssues(entry.input, input, entry.validate);
}

export { jsonSample, jsonSchemaView };

export interface SavedTemplate { id: string; name: string; api: string; tool: string; values: Record<string, unknown>; }
export const TEMPLATE_STORAGE = 'clyops.web.templates.v1';

/** Store only known non-secret overrides, preserving explicit false and zero. */
export function template(schema: Schema, api: string, tool: string, name: string, values: Record<string, unknown>): SavedTemplate {
  return { id: crypto.randomUUID(), name: name.trim(), api, tool, values: withoutSecrets(schema, values) };
}

/** Validate persisted records before restoring; secrets and undeclared fields are always discarded. */
export function restoreTemplate(schema: Schema, record: SavedTemplate): Record<string, unknown> {
  const values = withoutSecrets(schema, record.values);
  const known = new Set(formFields(schema).map(field => field.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => known.has(key)));
}

/** Decode a captured binary envelope into a downloadable file. */
export function resultBlob(stdout: string, encoding: string | undefined, contentType = 'text/plain'): Blob {
  if (encoding === 'base64') return new Blob([Uint8Array.from(atob(stdout), char => char.charCodeAt(0))], { type: contentType });
  return new Blob([stdout], { type: contentType });
}

/**
 * A progress update (spec section 14) as a fraction from 0 to 1, from `pct` or `done`/`total`, and
 * its label (`message`, else `stage`). The fraction is undefined when the update has no number.
 */
export function progressView(update: Record<string, unknown> | null | undefined): { fraction?: number; label?: string } {
  if (!update) return {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const pct = num(update.pct);
  const done = num(update.done);
  const total = num(update.total);
  const raw = pct !== undefined ? pct / 100 : done !== undefined && total ? done / total : undefined;
  const fraction = raw === undefined ? undefined : Math.min(1, Math.max(0, raw));
  const label = typeof update.message === 'string' ? update.message : typeof update.stage === 'string' ? update.stage : undefined;
  return { ...(fraction !== undefined ? { fraction } : {}), ...(label !== undefined ? { label } : {}) };
}
