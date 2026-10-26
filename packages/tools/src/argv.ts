// JSON input -> command line for a clyops tool (spec/SPEC.md section 13).
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Schema, SchemaArgument, SchemaOption } from './schema.js';

/** Input the caller got wrong: an API answers it with `status` (400). */
export class InputError extends Error {
  /** HTTP status used by adapters to report invalid caller input. */
  status = 400;
}

/** JSON input keyed by option or argument name; null and undefined values are omitted. */
export type Input = Record<string, unknown>;

/** Controls path resolution, templates, positional order, secret transport, and allowed path boundaries. */
export interface ArgvOptions {
  /** Directory that relative path values resolve against (default: leave them to the tool). */
  base?: string;
  /** Option and argument names the caller sets itself; input keys for them are reported in `controlled`. */
  controlled?: string[];
  /** Applied to every string value before it is used (templating). */
  render?: (value: string) => string;
  /** Explicit positional values, or their order (default: 'first'). */
  positionals?: string[] | 'first' | 'last';
  /** Order when also supplying explicit positional values. */
  positionalsOrder?: 'first' | 'last';
  /**
   * Pass secret options (spec section 1.5) in the environment, under their
   * variable names, instead of on the command line where `ps` shows them.
   * Array options stay on the command line.
   */
  secretEnv?: boolean;
  /**
   * Path-valued inputs must resolve inside one of these directories (relative
   * ones against `base`, else `cwd`); anything else is an InputError.
   */
  within?: string[];
  /** The tool's working directory, for `within` (default: this process's). */
  cwd?: string;
}

/** Generated argv and secret environment, plus unknown and caller-controlled input keys. */
export interface Argv {
  /** Arguments to pass to the executable, excluding its filename. */
  argv: string[];
  /** Variables to add to the tool's environment (secrets, with `secretEnv`). */
  env: Record<string, string>;
  /** Input keys that matched no option or argument. */
  unknown: string[];
  /** Input keys for options and arguments named in `controlled`, not passed on. */
  controlled: string[];
}

export { inputKey, inputKeys, isBareFlag } from 'clyops-schema';
import { inputKeys, isBareFlag } from 'clyops-schema';

/** Whether a schema type or validation rule denotes a filesystem path. */
export function isPathValued(validation: string, type?: string): boolean {
  return type === 'path' || validation === 'path' || validation.startsWith('file:') || validation.startsWith('dir:');
}

// A file:executable value naming a program on PATH (spec section 5): not a path to resolve or confine.
function isBareProgram(validation: string, value: string): boolean {
  return validation === 'file:executable' && value !== '' && !value.includes('/') && !(process.platform === 'win32' && value.includes('\\'));
}

// An array given to a single `json` or `json:SCHEMA` input is one JSON value, not a list (spec section 13).
function oneJsonValue(validation: string, many: boolean): boolean {
  return (validation === 'json' || validation.startsWith('json:')) && !many;
}

const TRUE = /^(true|1|yes|on)$/i;
const FALSE = /^(false|0|no|off)$/i;

/**
 * Map `input` onto `schema`. Positionals come first unless configured otherwise
 * or a leading dash requires placing them after the options and `--`.
 */
export function toArgv(schema: Schema, input: Input, opts: ArgvOptions = {}): Argv {
  const used = new Set<string>();
  const out: Argv = { argv: [], env: {}, unknown: [], controlled: [] };

  const pick = (item: SchemaOption | SchemaArgument): { key: string; value: unknown } | undefined => {
    for (const key of inputKeys(item)) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        used.add(key);
        return { key, value: input[key] };
      }
    }
    return undefined;
  };

  const text = (value: unknown, pathValued: boolean, name = '', validation = ''): string => {
    let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (opts.render) s = opts.render(s);
    if (isBareProgram(validation, s)) return s;
    // Empty, '-' (stdin), absolute paths and URLs are left alone, as are the
    // 'disabled' and 'false' sentinels some tools use to turn a path off.
    if (pathValued && opts.base && !['', '-', 'disabled', 'false'].includes(s) && !isAbsolute(s) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      s = resolve(opts.base, s);
    }
    if (pathValued && opts.within) checkWithin(name, s, opts.within, opts.base ?? opts.cwd ?? process.cwd());
    return s;
  };

  for (const option of schema.options) {
    const found = pick(option);
    if (!found) continue;
    if (opts.controlled?.includes(option.name)) {
      out.controlled.push(found.key);
      continue;
    }
    if (found.value === null || found.value === undefined) continue;
    if (isBareFlag(option)) {
      if (!['boolean', 'string', 'number'].includes(typeof found.value)) {
        throw new InputError(`--${option.name} must be a boolean (true/false, yes/no, 1/0, on/off)`);
      }
      const value = text(found.value, false);
      if (!TRUE.test(value) && !FALSE.test(value)) {
        throw new InputError(`--${option.name} must be a boolean (true/false, yes/no, 1/0, on/off), got '${value}'`);
      }
      out.argv.push(TRUE.test(value) ? `--${option.name}` : `--no-${option.name}`);
      continue;
    }
    if (opts.secretEnv && option.secret && !option.isArray) {
      out.env[option.variableName] = text(found.value, isPathValued(option.validation, option.type), `--${option.name}`, option.validation);
      continue;
    }
    for (const item of Array.isArray(found.value) && !oneJsonValue(option.validation, option.isArray) ? found.value : [found.value]) {
      out.argv.push(`--${option.name}`, text(item, isPathValued(option.validation, option.type), `--${option.name}`, option.validation));
    }
  }

  const explicit = Array.isArray(opts.positionals) ? opts.positionals : undefined;
  const order = typeof opts.positionals === 'string' ? opts.positionals : opts.positionalsOrder ?? 'first';
  if (order !== 'first' && order !== 'last') throw new InputError("positionals order must be first or last");
  const positionals = [...(explicit ?? [])];
  if (!explicit) {
    // Positionals are assigned in order, so an argument left out before one
    // that is given takes its default.
    let skipped: SchemaArgument[] = [];
    for (const argument of schema.arguments) {
      const found = pick(argument);
      if (found && opts.controlled?.includes(argument.name)) {
        out.controlled.push(found.key);
        skipped.push(argument);
        continue;
      }
      if (!found || found.value === null || found.value === undefined) {
        skipped.push(argument);
        continue;
      }
      for (const gap of skipped) {
        if (!gap.default) throw new Error(`${argument.name} is given, so ${gap.name} must be too`);
        positionals.push(text(gap.default, false));
      }
      skipped = [];
      const values = Array.isArray(found.value) && !oneJsonValue(argument.validation, argument.isVariadic) ? found.value : [found.value];
      positionals.push(...values.map((v) => text(v, isPathValued(argument.validation), argument.name, argument.validation)));
    }
  }
  if (positionals.some((p) => p.startsWith('-'))) out.argv.push('--', ...positionals);
  else if (order === 'last') out.argv.push(...positionals);
  else out.argv.unshift(...positionals);

  out.unknown = Object.keys(input).filter((k) => !used.has(k));
  return out;
}

// The real path of `p`, or of its deepest existing ancestor joined with the rest.
function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(head.slice(dirname(head).length).replace(/^[\\/]/, ''));
    head = dirname(head);
  }
  return resolve(existsSync(head) ? realpathSync(head) : head, ...tail);
}

/** Throws an InputError unless path value `value` of `name` resolves inside one of `dirs`. */
export function checkWithin(name: string, value: string, dirs: string[], base: string): void {
  if (['', '-', 'disabled', 'false'].includes(value)) return;
  if (/^[a-z][a-z0-9+.-]+:/i.test(value) && !isAbsolute(value)) {
    throw new InputError(`${name}: ${value} is not a path inside the allowed directories`);
  }
  const target = realish(resolve(base, value));
  const inside = dirs.some((dir) => {
    const rel = relative(realish(resolve(dir)), target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!inside) throw new InputError(`${name}: ${value} is outside the allowed directories`);
}

/** `argv` with the values of secret options replaced by `***`, for display and logs. */
export function redactArgv(schema: Schema, argv: string[]): string[] {
  const secret = new Set(schema.options.filter((o) => o.secret).map((o) => `--${o.name}`));
  const out = [...argv];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '--') break;
    const eq = out[i].indexOf('=');
    if (eq > 0 && secret.has(out[i].slice(0, eq))) out[i] = `${out[i].slice(0, eq)}=***`;
    else if (secret.has(out[i]) && i + 1 < out.length) out[++i] = '***';
  }
  return out;
}
