// clyops-doc: documentation (man, Markdown, HTML) from a clyops tool's --help-json-schema.
export * from './model.js';
export * from './render.js';

import type { Schema } from 'clyops-schema';
import { buildDoc, type DocOptions } from './model.js';
import { render, type Format } from './render.js';

/** A schema's documentation in `format` (default man). Throws for input that isn't a clyops schema. */
export function document(schema: Schema, format: Format = 'man', opts: DocOptions = {}): string {
  return render(buildDoc(schema, opts), format);
}
