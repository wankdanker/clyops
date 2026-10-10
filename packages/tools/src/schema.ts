// The `--help-json-schema` contract (spec/SPEC.md section 8), and reading it
// from a tool.
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { usesClyops } from './detection.js';

/** A positional argument as declared by a tool schema. */
export interface SchemaArgument {
  /** Program, command, option, or argument name as declared in its containing type. */
  name: string;
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Whether an explicit value is required. */
  required: boolean;
  /** Whether this positional collects the remaining arguments. */
  isVariadic: boolean;
  /** Declared default as schema text; empty means no default. */
  default: string;
  /** Validation rule in the shared specification. */
  validation: string;
}

/** An option as declared by a tool schema. */
export interface SchemaOption {
  /** Program, command, option, or argument name as declared in its containing type. */
  name: string;
  /** One-character option alias, or empty when absent. */
  shortName: string;
  /** Option variable name, used for environment lookup and resolved values. */
  variableName: string;
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Declared default as schema text; empty means no default. */
  default: string;
  /** Help section containing this option. */
  group: string;
  /** Declared value type or relationship kind, according to the containing interface. */
  type: 'string' | 'boolean' | 'integer' | 'number' | 'choice' | 'path';
  /** Whether the option has flag semantics. */
  isFlag: boolean;
  /** Whether repeated option values accumulate in an array. */
  isArray: boolean;
  /** Whether an explicit value is required. */
  required: boolean;
  /** Validation rule in the shared specification. */
  validation: string;
  /** Accepted values for a choice option. */
  choices: string[];
  /** Holds a secret (spec section 1.5); absent in schemas from before 0.2. */
  secret?: boolean;
}

/** What running a tool does (spec section 1.3). */
export type Effect = 'read-only' | 'idempotent' | 'destructive' | 'network';

/** A declared stdin or stdout (spec section 1.3). */
export interface SchemaStream {
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Declared MIME type, or an empty string when unspecified. */
  contentType: string;
}

/** An option relationship (spec section 1.6). */
export interface SchemaConstraint {
  /** Declared value type or relationship kind, according to the containing interface. */
  type: 'exclusive' | 'requires' | 'oneOf';
  /** Long option names participating in this relationship. */
  options: string[];
}

/** The fields a program and each of its commands share. Fields added in 0.2 are optional. */
export interface SchemaBody {
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Text shown after the help sections. */
  epilog: string;
  /** Positional arguments in registration order. */
  arguments: SchemaArgument[];
  /** Options declared at this command level, in registration order. */
  options: SchemaOption[];
  /** External executables required by the tool, with descriptions and install hints. */
  requiredCommands: {
    /** Executable name searched for on PATH. */
    command: string;
    /** Why the executable is needed. */
    description: string;
    /** Installation instructions when the executable is absent. */
    installHint: string;
  }[];
  /** Declared read-only, idempotent, destructive, or network effects. */
  effects?: Effect[];
  /** Declared exclusive, requires, and oneOf option relationships. */
  constraints?: SchemaConstraint[];
  /** Declared input stream, or null/absent when none is declared. */
  stdin?: SchemaStream | null;
  /** Declared output stream, or null/absent when undeclared (text output). */
  stdout?: SchemaStream | null;
  /** Nested commands with their own options, arguments, and metadata. */
  commands?: SchemaCommand[];
}

/** A command (spec section 1.7): its own options only. */
export interface SchemaCommand extends SchemaBody {
  /** Program, command, option, or argument name as declared in its containing type. */
  name: string;
}

/** Root schema with the format discriminator and declared program name. */
export interface Schema extends SchemaBody {
  /** Schema format discriminator; currently 1. */
  clyops: number;
  /** Program name declared by the tool, which may differ from its executable path. */
  script: string;
}

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
