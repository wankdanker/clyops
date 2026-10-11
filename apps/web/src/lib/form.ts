import Ajv from 'ajv';
import { formFields, withoutSecrets, type Schema, type ValueSpec, type FormField } from 'clyops-schema';

const ajv = new Ajv({ allErrors: true, strict: false });

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
    type: field.secret ? 'password' : value.type === 'integer' || value.type === 'number' ? 'number' : field.validation === 'date:YYYY-MM-DD' ? 'date' : 'text',
    min: value.minimum, max: value.maximum, step: value.type === 'integer' ? 1 : 'any',
    minlength: value.minLength, maxlength: value.maxLength,
  };
}

/** Validate only supplied JSON inputs; the tool resolves inheritance and remaining requirements. */
export function inputErrors(inputSchema: object, input: Record<string, unknown>): string[] {
  const validate = ajv.compile(inputSchema);
  if (validate(input)) return [];
  return (validate.errors ?? []).map(error => `${error.instancePath.slice(1) || (error.params.missingProperty as string) || 'Input'}: ${error.message}`);
}

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
