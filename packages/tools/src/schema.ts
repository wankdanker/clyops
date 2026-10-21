// The `--help-json-schema` contract (spec/SPEC.md section 8), and reading it
// from a tool.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { usesClyops } from './detection.js';

export type { SchemaArgument, SchemaOption, Effect, SchemaStream, SchemaRole, SchemaConstraint, SchemaBody, SchemaCommand, Schema } from 'clyops-schema';
import type { Schema } from 'clyops-schema';

/** What an executable is, judged from its contents (spec section 12). */
export type Kind = 'tool' | 'dispatcher' | 'other';

/** Inspect an executable without running it; returns tool, dispatcher, or other. */
export function classify(file: string): Kind {
  let text: string;
  try {
    text = readFileSync(file, 'latin1');
  } catch {
    return 'other';
  }
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  if (firstLine.startsWith('#!') && firstLine.includes('clyops-dispatch')) return 'dispatcher';
  return usesClyops(text) ? 'tool' : 'other';
}

/** A key that changes whenever the file does. */
export function stamp(file: string): string {
  const s = statSync(file);
  return `${s.mtimeMs}:${s.size}`;
}

const cache = new Map<string, { stamp: string; schema: Promise<Schema> }>();

/**
 * Run `file --help-json-schema` and parse its output, cached until the file
 * changes. Text around the JSON object (a stray log line) is ignored.
 */
export function loadSchema(file: string, opts: { /** Working directory used to resolve command-line paths and execute tools. */ cwd?: string; timeoutMs?: number } = {}): Promise<Schema> {
  const key = stamp(file);
  const hit = cache.get(file);
  if (hit && hit.stamp === key) return hit.schema;
  const schema = new Promise<Schema>((resolve, reject) => {
    execFile(file, ['--help-json-schema'], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 5000, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`${file} does not provide --help-json-schema: ${err.message}`));
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start < 0 || end < start) return reject(new Error(`${file} produced no JSON schema`));
      try {
        const parsed = JSON.parse(stdout.slice(start, end + 1)) as Schema;
        if (parsed.clyops !== 1 || !Array.isArray(parsed.options) || !Array.isArray(parsed.arguments) || typeof parsed.description !== 'string') {
          throw new Error('expected a clyops: 1 schema with description, options and arguments');
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`${file}: invalid JSON schema: ${(e as Error).message}`));
      }
    });
  });
  // A failed load is not cached, so a fixed tool is picked up without a restart.
  schema.catch(() => cache.delete(file));
  cache.set(file, { stamp: key, schema });
  return schema;
}
