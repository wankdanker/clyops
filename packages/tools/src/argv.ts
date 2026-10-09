// JSON input -> command line for a clyops tool (spec/SPEC.md section 13).
import { isAbsolute, resolve } from 'node:path';
import type { Schema, SchemaArgument, SchemaOption } from './schema.js';

export type Input = Record<string, unknown>;

export interface ArgvOptions {
  /** Directory that relative path values resolve against (default: leave them to the tool). */
  base?: string;
  /** Option names the caller sets itself; input keys for them are reported in `controlled`. */
  controlled?: string[];
  /** Applied to every string value before it is used (templating). */
  render?: (value: string) => string;
  /** Use these positionals instead of mapping the schema's arguments from the input. */
  positionals?: string[];
}

export interface Argv {
  argv: string[];
  /** Input keys that matched no option or argument. */
  unknown: string[];
  /** Input keys for options named in `controlled`, not passed on. */
  controlled: string[];
}

/** The input key for an option or argument name: `dry-run` -> `dry_run`. */
export function inputKey(name: string): string {
  return name.replace(/-/g, '_');
}

/** Input keys accepted for an option or argument, in order of preference. */
export function inputKeys(item: SchemaOption | SchemaArgument): string[] {
  const variable = 'variableName' in item ? item.variableName : item.name;
  return [...new Set([inputKey(item.name), item.name, variable.toLowerCase()])].filter(Boolean);
}

/** True for a flag option, which takes no value on the command line. */
export function isBareFlag(option: SchemaOption): boolean {
  const choices = [...option.choices].sort().join(',');
  return option.isFlag && choices !== 'false,true';
}

export function isPathValued(validation: string, type?: string): boolean {
  return type === 'path' || validation === 'path' || validation.startsWith('file:') || validation.startsWith('dir:');
}

const TRUE = /^(true|1|yes|on)$/i;

/**
 * Map `input` onto `schema`. Options come first, then `--` and the positionals,
 * so a positional that starts with `-` is never taken for an option.
 */
export function toArgv(schema: Schema, input: Input, opts: ArgvOptions = {}): Argv {
  const used = new Set<string>();
  const out: Argv = { argv: [], unknown: [], controlled: [] };

  const pick = (item: SchemaOption | SchemaArgument): { key: string; value: unknown } | undefined => {
    for (const key of inputKeys(item)) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        used.add(key);
        return { key, value: input[key] };
      }
    }
    return undefined;
  };

  const text = (value: unknown, pathValued: boolean): string => {
    let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (opts.render) s = opts.render(s);
    // Empty, '-' (stdin), absolute paths and URLs are left alone, as are the
    // 'disabled' and 'false' sentinels some tools use to turn a path off.
    if (pathValued && opts.base && !['', '-', 'disabled', 'false'].includes(s) && !isAbsolute(s) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      s = resolve(opts.base, s);
    }
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
      const on = found.value === true || TRUE.test(String(found.value));
      out.argv.push(on ? `--${option.name}` : `--no-${option.name}`);
      continue;
    }
    for (const item of Array.isArray(found.value) ? found.value : [found.value]) {
      out.argv.push(`--${option.name}`, text(item, isPathValued(option.validation, option.type)));
    }
  }

  const positionals = [...(opts.positionals ?? [])];
  if (!opts.positionals) {
    // Positionals are assigned in order, so an argument left out before one
    // that is given takes its default.
    let skipped: SchemaArgument[] = [];
    for (const argument of schema.arguments) {
      const found = pick(argument);
      if (!found || found.value === null || found.value === undefined) {
        skipped.push(argument);
        continue;
      }
      for (const gap of skipped) {
        if (!gap.default) throw new Error(`${argument.name} is given, so ${gap.name} must be too`);
        positionals.push(text(gap.default, false));
      }
      skipped = [];
      const values = Array.isArray(found.value) ? found.value : [found.value];
      positionals.push(...values.map((v) => text(v, isPathValued(argument.validation))));
    }
  }
  if (positionals.length) out.argv.push('--', ...positionals);

  out.unknown = Object.keys(input).filter((k) => !used.has(k));
  return out;
}
