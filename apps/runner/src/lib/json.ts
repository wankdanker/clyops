// json and json:SCHEMA inputs (spec section 5): parsed and checked against their schema as you
// type, with ajv, as clyops-api and clyops-mcp check them before a tool runs.
import Ajv, { type ValidateFunction } from 'ajv';
import { checkableInputSchema, formFields, inputIssues, toJsonSchema, type FormField, type JsonSchema, type Schema } from 'clyops-schema';
import type { FormValues, ScriptSchema } from '../types';

const ajv = new Ajv({ allErrors: true, strict: false });

interface Compiled { input: JsonSchema; validate: ValidateFunction; fields: Record<string, FormField>; unchecked: Record<string, string> }
// Each schema is compiled once; the form checks on every change.
const compiled = new WeakMap<ScriptSchema, Compiled>();

function compile(schema: ScriptSchema): Compiled {
  let entry = compiled.get(schema);
  if (!entry) {
    // A json field whose schema doesn't compile is left unchecked, as clyops-api and clyops-mcp leave it.
    const unchecked: Record<string, string> = {};
    const input = checkableInputSchema(toJsonSchema(schema as unknown as Schema, 'declared'), (s) => new Ajv({ strict: false }).compile(s), (key, err) => { unchecked[key] = err.message; });
    const fields = Object.fromEntries(formFields(schema as unknown as Schema, 'declared').filter((field) => field.json).map((field) => [field.key, field]));
    entry = { input, validate: ajv.compile(input), fields, unchecked };
    compiled.set(schema, entry);
  }
  return entry;
}

/** The json fields of a command level, by declared name. */
export function jsonFields(schema: ScriptSchema): Record<string, FormField> {
  return compile(schema).fields;
}

/** Why each json field whose schema doesn't compile isn't checked, by declared name. */
export function jsonUnchecked(schema: ScriptSchema): Record<string, string> {
  return compile(schema).unchecked;
}

/**
 * Each json field's problems, by name: text that isn't JSON, or a value its schema rejects. A
 * field left empty (or an empty repeated item) isn't given, so it isn't checked.
 */
export function jsonIssues(schema: ScriptSchema, values: FormValues): Record<string, string[]> {
  const { input, validate, fields } = compile(schema);
  const given: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = values[key];
    if (field.many && Array.isArray(value)) {
      const items = value.filter((item) => String(item).trim() !== '');
      if (items.length) given[key] = items;
    } else if (typeof value === 'string' && value.trim() !== '') given[key] = value;
  }
  const out: Record<string, string[]> = {};
  for (const issue of inputIssues(input, given, validate)) {
    const key = issue.slice(0, issue.indexOf(':'));
    if (key in fields) (out[key] ??= []).push(issue.slice(key.length + 2));
  }
  return out;
}
