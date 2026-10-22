// clyops-doc: documentation (man, Markdown, HTML) from a clyops tool's --help-json-schema.
export * from './model.js';
export * from './render.js';

import type { Schema } from 'clyops-schema';
import { buildDoc, leafSchema, leaves, pageName, type DocOptions } from './model.js';
import { render, type Format } from './render.js';

/** A schema's documentation in `format` (default man). Throws for input that isn't a clyops schema. */
export function document(schema: Schema, format: Format = 'man', opts: DocOptions = {}): string {
  return render(buildDoc(schema, opts), format);
}

/** One file of a split document. */
export interface Page {
  /** File name, e.g. `mytool-db-migrate.1`, `mytool.md`. */
  file: string;
  /** The page in its format. */
  content: string;
}

/** A page's file extension: the manual section for man, else the format's. */
export function extension(format: Format, section = '1'): string {
  return format === 'man' ? section : format === 'markdown' ? 'md' : 'html';
}

/**
 * The documentation as a page per runnable command, git-style: `mytool.1` lists the commands and
 * each has its own, e.g. `mytool-db-migrate.1`, with what it inherits. A program without commands
 * is one page. Throws for input that isn't a clyops schema, or for two commands with one page name.
 */
export function pages(schema: Schema, format: Format = 'man', opts: DocOptions = {}): Page[] {
  const name = opts.name || (schema as Schema | null)?.script || '';
  const top = buildDoc(schema, { ...opts, split: true, page: pageName(name) });
  const ext = extension(format, top.section);
  const out: Page[] = [{ file: `${top.page}.${ext}`, content: render(top, format) }];
  const all = leaves(schema);
  if (all.length === 1 && all[0].words.length === 0) return out;
  for (const leaf of all) {
    const page = pageName(name, leaf.words);
    const doc = buildDoc(leafSchema(schema, leaf), { ...opts, split: false, name: [name, ...leaf.words].join(' '), page });
    doc.sections.push({ title: 'SEE ALSO', blocks: [{ kind: 'refs', items: [{ page: pageName(name), section: top.section }] }] });
    const file = `${page}.${ext}`;
    if (out.some((p) => p.file === file)) throw new Error(`two pages would be named ${file}`);
    out.push({ file, content: render(doc, format) });
  }
  return out;
}
