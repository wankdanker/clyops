// The `--help-json-schema` contract (spec/SPEC.md section 8), and reading it
// from a tool.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

export interface SchemaArgument {
  name: string;
  description: string;
  required: boolean;
  isVariadic: boolean;
  default: string;
  validation: string;
}

export interface SchemaOption {
  name: string;
  shortName: string;
  variableName: string;
  description: string;
  default: string;
  group: string;
  type: 'string' | 'boolean' | 'integer' | 'number' | 'choice' | 'path';
  isFlag: boolean;
  isArray: boolean;
  required: boolean;
  validation: string;
  choices: string[];
  /** Holds a secret (spec section 1.5); absent in schemas from before 0.2. */
  secret?: boolean;
}

/** What running a tool does (spec section 1.3). */
export type Effect = 'read-only' | 'idempotent' | 'destructive' | 'network';

/** A declared stdin or stdout (spec section 1.3). */
export interface SchemaStream {
  description: string;
  contentType: string;
}

/** An option relationship (spec section 1.6). */
export interface SchemaConstraint {
  type: 'exclusive' | 'requires' | 'oneOf';
  options: string[];
}

/** The fields a program and each of its commands share. Fields added in 0.2 are optional. */
export interface SchemaBody {
  description: string;
  epilog: string;
  arguments: SchemaArgument[];
  options: SchemaOption[];
  requiredCommands: { command: string; description: string; installHint: string }[];
  effects?: Effect[];
  constraints?: SchemaConstraint[];
  stdin?: SchemaStream | null;
  stdout?: SchemaStream | null;
  commands?: SchemaCommand[];
}

/** A command (spec section 1.7): its own options only. */
export interface SchemaCommand extends SchemaBody {
  name: string;
}

export interface Schema extends SchemaBody {
  clyops: number;
  script: string;
}

/** What an executable is, judged from its contents (spec section 12). */
export type Kind = 'tool' | 'dispatcher' | 'other';

// Strings found in programs built on a clyops library; see the dispatcher's
// "Which programs are run". Only these are run to ask for their schema, since
// running an arbitrary executable with an unknown flag could do real work.
const MARKERS = ['#clyops-completion', 'clyops.sh', 'import clyops', 'from clyops', "'clyops'", '"clyops"', 'clyops-tool'];

export function classify(file: string): Kind {
  let text: string;
  try {
    text = readFileSync(file, 'latin1');
  } catch {
    return 'other';
  }
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  if (firstLine.startsWith('#!') && firstLine.includes('clyops-dispatch')) return 'dispatcher';
  return MARKERS.some((m) => text.includes(m)) ? 'tool' : 'other';
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
export function loadSchema(file: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Schema> {
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
        resolve(JSON.parse(stdout.slice(start, end + 1)) as Schema);
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
