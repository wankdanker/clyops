// clyops — declarative CLI parsing for Node.js. Behavior follows spec/SPEC.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { format } from 'node:util';
import { COMPLETION_SCRIPTS } from './completions.js';

export type Scalar = string | number | boolean;
export type Value = Scalar | Scalar[] | null;
export type Source = 'cli' | 'config' | 'env' | 'default' | 'unset';

/**
 * Validation rule. See spec/SPEC.md section 5. Template types give editor
 * completion for the fixed rules while still accepting parameterized ones.
 */
export type Validation =
  | '' | 'int' | 'float' | 'string' | 'path' | 'ip' | 'hostname' | 'url' | 'port' | 'email' | 'uuid' | 'bool'
  | 'date:YYYY-MM-DD' | 'file:exists' | 'file:readable' | 'file:writable' | 'dir:exists' | 'dir:writable'
  | `int:${string}` | `float:${string}` | `string:${string}` | `choice:${string}` | `regex:${string}`;

export interface CliOptions {
  /** Program name shown in usage. Defaults to the basename of process.argv[1]. */
  name?: string;
  /** Base directory for default/env path values and search dirs. Defaults to cwd. */
  root?: string;
  /** Directory command-line paths are relative to. Defaults to process.cwd(). */
  cwd?: string;
  /** Environment to read option values from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export type ParseResult =
  | { status: 'ok' }
  | { status: 'help' }
  | { status: 'error'; error: string; showUsage: boolean; detail?: string[] };

interface OptionDef {
  varName: string;
  long: string;
  short: string;
  kind: 'flag' | 'value' | 'array';
  defaultValue: string; // '' when none
  required: boolean;
  description: string;
  group: string;
  validation: string;
  searchDirs: string[];
}

interface ArgDef {
  name: string;
  description: string;
  defaultValue: string;
  validation: string;
  variadic: boolean;
}

interface RequiredCommand {
  command: string;
  description: string;
  installHint: string;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const COLORS: Record<string, string> = {
  info: '\x1b[1;37m', warning: '\x1b[0;33m', error: '\x1b[0;31m', success: '\x1b[0;32m',
};

let silent = process.env.CLYOPS_SILENT === 'true';

/** Suppress info/warn/error/success output (die and parse errors still print). */
export function setSilent(value: boolean): void {
  silent = value;
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function emit(level: string, msg: string, force = false): void {
  if (silent && !force) return;
  const color = process.stderr.isTTY && !process.env.NO_COLOR;
  const tag = color ? `${COLORS[level]}${level}\x1b[0m` : level;
  process.stderr.write(`${timestamp()} [${tag}] ${msg}\n`);
}

export function info(fmt: string, ...args: unknown[]): void { emit('info', format(fmt, ...args)); }
export function warn(fmt: string, ...args: unknown[]): void { emit('warning', format(fmt, ...args)); }
export function error(fmt: string, ...args: unknown[]): void { emit('error', format(fmt, ...args)); }
export function success(fmt: string, ...args: unknown[]): void { emit('success', format(fmt, ...args)); }

/** Print an error and exit with `code`. Never suppressed. */
export function die(code: number, fmt: string, ...args: unknown[]): never {
  emit('error', format(fmt, ...args), true);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOOL_TRUE = ['true', 'yes', '1', 'on'];
const BOOL_FALSE = ['false', 'no', '0', 'off'];

function boolWord(value: string): boolean | undefined {
  const lower = value.toLowerCase();
  if (BOOL_TRUE.includes(lower)) return true;
  if (BOOL_FALSE.includes(lower)) return false;
  return undefined;
}

const FIXED_RULES = new Set([
  'int', 'float', 'string', 'path', 'ip', 'hostname', 'url', 'port', 'email', 'uuid', 'bool',
  'date:YYYY-MM-DD', 'file:exists', 'file:readable', 'file:writable', 'dir:exists', 'dir:writable',
]);

function isKnownRule(rule: string): boolean {
  if (!rule || FIXED_RULES.has(rule)) return true;
  if (/^int:(\d+-\d*|-\d+)$/.test(rule)) return true;
  if (/^float:(\d*\.?\d+-(\d*\.?\d+)?|-\d*\.?\d+)$/.test(rule)) return true;
  if (/^string:(\d+|\d+-\d*|-\d+)$/.test(rule)) return true;
  if (/^choice:.+/.test(rule)) return true;
  if (/^regex:.+/.test(rule)) {
    try { new RegExp(rule.slice(6)); return true; } catch { return false; }
  }
  return false;
}

/** Split "MIN-MAX" into its (possibly empty) bounds. */
function bounds(rule: string): [string, string] {
  const range = rule.slice(rule.indexOf(':') + 1);
  const dash = range.indexOf('-');
  return [range.slice(0, dash), range.slice(dash + 1)];
}

export function isPathRule(rule: string): boolean {
  return rule === 'path' || rule.startsWith('file:') || rule.startsWith('dir:');
}

/** Help text for a validation rule (spec section 5). */
export function describeRule(rule: string): string {
  const fixed: Record<string, string> = {
    int: 'integer', float: 'number', string: 'text', path: 'path', ip: 'IP address', hostname: 'hostname',
    url: 'URL', port: 'port: 1-65535', email: 'email address', uuid: 'UUID',
    bool: 'true/false, yes/no, 1/0, on/off', 'date:YYYY-MM-DD': 'date: YYYY-MM-DD',
    'file:exists': 'existing file', 'file:readable': 'readable file', 'file:writable': 'writable file',
    'dir:exists': 'existing directory', 'dir:writable': 'writable directory',
  };
  if (rule in fixed) return fixed[rule];
  for (const [prefix, noun, suffix] of [['int:', 'integer', ''], ['float:', 'number', ''], ['string:', 'text', ' chars']]) {
    if (!rule.startsWith(prefix)) continue;
    if (!rule.includes('-')) return `${noun}: ${rule.slice(prefix.length)}${suffix}`;
    const [min, max] = bounds(rule);
    if (min && max) return `${noun}: ${min}-${max}${suffix}`;
    return min ? `${noun}: >=${min}${suffix}` : `${noun}: <=${max}${suffix}`;
  }
  if (rule.startsWith('choice:')) return `choices: ${rule.slice(7).split(',').join(', ')}`;
  if (rule.startsWith('regex:')) return `pattern: ${rule.slice(6)}`;
  return rule;
}

function isWritable(p: string, mode = fs.constants.W_OK): boolean {
  try { fs.accessSync(p, mode); return true; } catch { return false; }
}

function statKind(p: string): 'file' | 'dir' | 'other' | undefined {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  } catch { return undefined; }
}

/**
 * Validate `value` against `rule` and convert it to its typed form.
 * Throws an Error whose message is the spec's error text.
 */
export function validate(value: string, rule: string, name: string): Scalar {
  const fail = (msg: string): never => { throw new Error(`${name} ${msg}`); };
  const checkBounds = (num: number, min: string, max: string) => {
    if (min && num < Number(min)) fail(`must be >= ${min}, got ${value}`);
    if (max && num > Number(max)) fail(`must be <= ${max}, got ${value}`);
  };

  if (rule === 'int' || rule.startsWith('int:')) {
    if (!/^-?[0-9]+$/.test(value)) fail(`must be an integer, got '${value}'`);
    const num = Number(value);
    if (rule !== 'int') checkBounds(num, ...bounds(rule));
    return num;
  }
  if (rule === 'float' || rule.startsWith('float:')) {
    if (!/^-?[0-9]*\.?[0-9]+$/.test(value)) fail(`must be a number, got '${value}'`);
    const num = Number(value);
    if (rule !== 'float') checkBounds(num, ...bounds(rule));
    return num;
  }
  if (rule.startsWith('string:')) {
    const len = [...value].length;
    if (!rule.includes('-')) {
      const exact = rule.slice(7);
      if (len !== Number(exact)) fail(`must be exactly ${exact} characters, got ${len}`);
    } else {
      const [min, max] = bounds(rule);
      if (min && len < Number(min)) fail(`must be at least ${min} characters, got ${len}`);
      if (max && len > Number(max)) fail(`must be at most ${max} characters, got ${len}`);
    }
    return value;
  }
  if (rule.startsWith('choice:')) {
    const choices = rule.slice(7).split(',');
    if (!choices.includes(value)) fail(`must be one of: ${choices.join(', ')}, got '${value}'`);
    return value;
  }
  if (rule.startsWith('regex:')) {
    if (!new RegExp(rule.slice(6)).test(value)) fail(`does not match required pattern, got '${value}'`);
    return value;
  }

  switch (rule) {
    case 'string':
    case 'path':
      return value;
    case 'bool': {
      const b = boolWord(value);
      if (b === undefined) fail(`must be a boolean (true/false, yes/no, 1/0, on/off), got '${value}'`);
      return b as boolean;
    }
    case 'port':
      if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        fail(`must be a valid port (1-65535), got '${value}'`);
      }
      return Number(value);
    case 'ip':
      if (!/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value) && !/^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$/.test(value)) {
        fail(`must be a valid IP address, got '${value}'`);
      }
      return value;
    case 'hostname':
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(value)) {
        fail(`must be a valid hostname, got '${value}'`);
      }
      return value;
    case 'url':
      if (!/^https?:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?(\/.*)?$/.test(value)) fail(`must be a valid URL, got '${value}'`);
      return value;
    case 'email':
      if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) fail(`must be a valid email address, got '${value}'`);
      return value;
    case 'uuid':
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
        fail(`must be a valid UUID, got '${value}'`);
      }
      return value;
    case 'date:YYYY-MM-DD':
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) fail(`must be in YYYY-MM-DD format, got '${value}'`);
      return value;
    case 'file:exists':
      if (statKind(value) !== 'file') fail(`file does not exist: ${value}`);
      return value;
    case 'file:readable':
      if (!isWritable(value, fs.constants.R_OK)) fail(`file is not readable: ${value}`);
      return value;
    case 'file:writable':
      if (statKind(value) !== undefined) {
        if (!isWritable(value)) fail(`file is not writable: ${value}`);
      } else {
        const dir = path.dirname(value);
        if (statKind(dir) !== 'dir' || !isWritable(dir)) fail(`directory is not writable: ${dir}`);
      }
      return value;
    case 'dir:exists':
      if (statKind(value) !== 'dir') fail(`directory does not exist: ${value}`);
      return value;
    case 'dir:writable':
      if (statKind(value) !== 'dir' || !isWritable(value)) fail(`directory does not exist or is not writable: ${value}`);
      return value;
  }
  return value;
}

/**
 * Resolve a path value against `base` (spec section 6). Bare relative values
 * missing under `base` fall back to the first search dir that has them.
 */
export function resolvePath(value: string, base: string, searchDirs: string[] = []): string {
  if (!value || ['-', 'disabled', 'optional'].includes(value)) return value;
  if (path.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]+:/.test(value)) return value;
  const fromBase = path.resolve(base, value);
  const bare = !/^\.\.?(\/|$)/.test(value);
  if (bare && searchDirs.length > 0 && !fs.existsSync(fromBase)) {
    for (const dir of searchDirs) {
      const candidate = path.resolve(dir, value);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return fromBase;
}

/** Greedy word wrap that keeps existing line breaks (spec section 7). */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const original of text.split(/\r?\n/)) {
    const words = original.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function isCommandAvailable(cmd: string, env: Record<string, string | undefined>): boolean {
  const candidates = cmd.includes('/') ? [cmd] : (env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, cmd));
  return candidates.some((c) => statKind(c) === 'file' && isWritable(c, fs.constants.X_OK));
}

function completionKind(rule: string, searchDirs: string[]): [string, string] {
  if (rule === 'path' || rule.startsWith('file:')) return ['file', searchDirs.join(':')];
  if (rule.startsWith('dir:')) return ['dir', searchDirs.join(':')];
  if (rule.startsWith('choice:')) return ['choice', rule.slice(7)];
  if (rule === 'bool') return ['choice', 'true,false'];
  if (rule === 'hostname' || rule === 'ip') return ['host', ''];
  if (rule) return ['none', ''];
  return ['default', ''];
}

function isBoolLike(opt: OptionDef): boolean {
  return opt.kind === 'flag' || ['bool', 'choice:true,false', 'choice:false,true'].includes(opt.validation);
}

// ---------------------------------------------------------------------------
// Cli
// ---------------------------------------------------------------------------

export class Cli {
  readonly name: string;
  readonly root: string;
  readonly cwd: string;
  /** Resolved, typed values keyed by option var / argument name. */
  values: Record<string, Value> = Object.create(null);

  private env: Record<string, string | undefined>;
  private description = '';
  private epilog = '';
  private options: OptionDef[] = [];
  private byLong = new Map<string, OptionDef>();
  private byShort = new Map<string, OptionDef>();
  private args: ArgDef[] = [];
  private commands: RequiredCommand[] = [];
  private configOption = '';
  private configPrefixes: string[] = [];

  // Per-parse state
  private raw = new Map<string, string | string[]>(); // options, by long name
  private argRaw = new Map<string, string | string[]>(); // positional arguments, by name
  private sources = new Map<string, Source>();
  private configValues = new Map<string, { value: string; dir: string }>();

  constructor(opts: CliOptions = {}) {
    this.name = opts.name ?? path.basename(process.argv[1] || 'cli');
    this.cwd = opts.cwd ?? process.cwd();
    this.root = path.resolve(this.cwd, opts.root ?? '.');
    this.env = opts.env ?? process.env;
  }

  setDescription(text: string): this { this.description = text; return this; }
  setEpilog(text: string): this { this.epilog = text; return this; }

  /** `option` holds the config file path; `prefixes` is comma-separated. */
  setConfig(option: string, prefixes: string): this {
    this.configOption = option;
    this.configPrefixes = prefixes.split(',').map((p) => p.trim()).filter(Boolean);
    return this;
  }

  requireCommand(command: string, description: string, installHint = ''): this {
    this.commands.push({ command, description, installHint });
    return this;
  }

  /** Fallback dirs (relative to root) for bare relative values of a path option. */
  setPathSearch(long: string, dirs: string | string[]): this {
    const opt = this.byLong.get(long);
    if (!opt) throw new Error(`setPathSearch: unknown option --${long}`);
    const list = Array.isArray(dirs) ? dirs : dirs.split(':');
    opt.searchDirs = list.filter(Boolean).map((d) => path.resolve(this.root, d));
    if (!opt.validation) opt.validation = 'path';
    return this;
  }

  /**
   * Register an option. `defaultValue` is a default, `'flag'` for a boolean
   * flag, `'optional'` for no default, or `''` to make the option required.
   */
  opt(varName: string, long: string, short: string, defaultValue: string, description: string,
    group = 'Options', validation: Validation = ''): this {
    const kind = defaultValue === 'flag' ? 'flag' : 'value';
    const dflt = defaultValue === 'flag' || defaultValue === 'optional' ? '' : defaultValue;
    return this.addOption({ varName, long, short, kind, defaultValue: dflt, required: defaultValue === '',
      description, group, validation, searchDirs: [] });
  }

  /** Register a repeatable option whose values accumulate into a list. */
  optArray(varName: string, long: string, short: string, description: string,
    group = 'Options', validation: Validation = ''): this {
    return this.addOption({ varName, long, short, kind: 'array', defaultValue: '', required: false,
      description, group, validation, searchDirs: [] });
  }

  /** Register a positional argument. An empty default makes it required. */
  arg(name: string, description: string, defaultValue = '', validation: Validation = ''): this {
    return this.addArg({ name, description, defaultValue, validation, variadic: false });
  }

  /** Register a final positional argument that collects all remaining tokens. */
  argVariadic(name: string, description: string, validation: Validation = ''): this {
    return this.addArg({ name, description, defaultValue: '', validation, variadic: true });
  }

  /** @deprecated Use {@link Cli.opt}; kept for scripts written against `getOpt`. */
  getOpt(...args: Parameters<Cli['opt']>): this { return this.opt(...args); }
  /** @deprecated Use {@link Cli.optArray}. */
  getOptArray(...args: Parameters<Cli['optArray']>): this { return this.optArray(...args); }
  /** @deprecated Use {@link Cli.arg}. */
  getArg(...args: Parameters<Cli['arg']>): this { return this.arg(...args); }
  /** @deprecated Use {@link Cli.argVariadic}. */
  getArgVariadic(...args: Parameters<Cli['argVariadic']>): this { return this.argVariadic(...args); }

  private addOption(opt: OptionDef): this {
    if (this.byLong.has(opt.long)) throw new Error(`Duplicate option --${opt.long}`);
    if (opt.short && (opt.short.length !== 1 || this.byShort.has(opt.short))) {
      throw new Error(`Invalid or duplicate short option -${opt.short}`);
    }
    if (!isKnownRule(opt.validation)) throw new Error(`Unknown validation rule '${opt.validation}' for --${opt.long}`);
    this.options.push(opt);
    this.byLong.set(opt.long, opt);
    if (opt.short) this.byShort.set(opt.short, opt);
    return this;
  }

  private addArg(arg: ArgDef): this {
    if (this.args.some((a) => a.variadic)) throw new Error(`Argument ${arg.name} registered after a variadic argument`);
    if (!isKnownRule(arg.validation)) throw new Error(`Unknown validation rule '${arg.validation}' for ${arg.name}`);
    this.args.push(arg);
    return this;
  }

  private ensureHelp(): void {
    if (this.byLong.has('help')) return;
    this.addOption({ varName: 'HELP', long: 'help', short: this.byShort.has('h') ? '' : 'h', kind: 'flag',
      defaultValue: '', required: false, description: 'Show this help message and exit', group: 'Global',
      validation: '', searchDirs: [] });
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  /** Parse without exiting. Values are available in `values` when status is 'ok'. */
  parse(argv: string[] = process.argv.slice(2)): ParseResult {
    this.raw.clear();
    this.argRaw.clear();
    this.sources.clear();
    this.configValues.clear();
    this.values = Object.create(null);
    this.ensureHelp();

    let err = this.scan(argv);
    if (!err && this.configOption) err = this.loadConfig();
    if (this.raw.get('help') === 'true') return { status: 'help' };
    if (err) return { status: 'error', error: err, showUsage: true };

    try {
      this.resolve();
    } catch (e) {
      return { status: 'error', error: (e as Error).message, showUsage: true };
    }

    const missingCmds = this.commands.filter((c) => !isCommandAvailable(c.command, this.env));
    if (missingCmds.length > 0) {
      const detail: string[] = [];
      for (const c of missingCmds) {
        detail.push(`  ${c.command} - ${c.description}`);
        if (c.installHint) detail.push(`    Install: ${c.installHint}`);
      }
      return { status: 'error', error: `Missing required command(s): ${missingCmds.map((c) => c.command).join(', ')}`,
        showUsage: false, detail };
    }

    const missing = this.options.filter((o) => o.required && !this.raw.get(o.long)).map((o) => `--${o.long}`);
    if (missing.length > 0) {
      return { status: 'error', error: `Missing required argument(s): ${missing.join(' ')}`, showUsage: true };
    }
    return { status: 'ok' };
  }

  private setCli(opt: OptionDef, value: string): void {
    if (opt.kind === 'array') {
      const list = (this.sources.get(opt.long) === 'cli' ? this.raw.get(opt.long) : []) as string[];
      this.raw.set(opt.long, [...list, value]);
    } else {
      this.raw.set(opt.long, value);
    }
    this.sources.set(opt.long, 'cli');
  }

  private scan(argv: string[]): string | undefined {
    let pos = 0;
    let rest: string[] | undefined;
    let endOfOptions = false;

    const positional = (token: string): string | undefined => {
      if (rest) { rest.push(token); return; }
      const arg = this.args[pos];
      if (!arg) return `Unexpected argument: ${token}`;
      pos++;
      if (arg.variadic) { rest = [token]; this.argRaw.set(arg.name, rest); } else this.argRaw.set(arg.name, token);
    };

    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      let err: string | undefined;

      if (endOfOptions || token === '-' || !token.startsWith('-')) {
        err = positional(token);
      } else if (token === '--') {
        endOfOptions = true;
      } else if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
        const opt = this.byLong.get(name);
        if (opt && eq >= 0) {
          const value = token.slice(eq + 1);
          if (opt.kind === 'flag') {
            const b = boolWord(value);
            if (b === undefined) return `Option --${name} expects a boolean value, got '${value}'`;
            this.setCli(opt, String(b));
          } else this.setCli(opt, value);
        } else if (opt) {
          if (opt.kind === 'flag') this.setCli(opt, 'true');
          else {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) return `Option --${name} requires an argument`;
            this.setCli(opt, next);
            i++;
          }
        } else if (name.startsWith('no-') && eq < 0 && this.byLong.has(name.slice(3))) {
          const target = this.byLong.get(name.slice(3)) as OptionDef;
          if (!isBoolLike(target)) return `Option --${name} can only be used with flag/boolean options`;
          this.setCli(target, 'false');
        } else {
          return `Unknown option: ${eq >= 0 ? token.slice(0, eq) : token}`;
        }
      } else {
        const cluster = token.slice(1);
        for (let j = 0; j < cluster.length; j++) {
          const opt = this.byShort.get(cluster[j]);
          if (!opt) return `Unknown option: -${cluster[j]}`;
          if (opt.kind === 'flag') { this.setCli(opt, 'true'); continue; }
          if (j + 1 < cluster.length) { this.setCli(opt, cluster.slice(j + 1)); break; }
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) return `Option -${cluster[j]} requires an argument`;
          this.setCli(opt, next);
          i++;
        }
      }
      if (err) return err;
    }
    return undefined;
  }

  private loadConfig(): string | undefined {
    const opt = this.byLong.get(this.configOption);
    if (!opt) return undefined;
    let file = this.raw.get(opt.long) as string | undefined;
    let source: Source = 'cli';
    if (file === undefined && this.env[opt.varName]) { file = this.env[opt.varName] as string; source = 'env'; }
    if (file === undefined && opt.defaultValue) { file = opt.defaultValue; source = 'default'; }
    if (!file || file === 'disabled') return undefined;

    const resolved = resolvePath(file, this.cwd, opt.searchDirs);
    this.raw.set(opt.long, resolved);
    this.sources.set(opt.long, source);
    const err = this.readConfig(resolved, 0, new Set());
    if (err) return err;

    for (const [key, { value }] of this.configValues) {
      const target = this.byLong.get(key);
      if (!target || this.sources.get(key) === 'cli' || target === opt) continue;
      if (target.kind === 'flag') {
        const b = boolWord(value);
        if (b === undefined) return `Config value for --${key} must be a boolean, got '${value}'`;
        this.raw.set(key, String(b));
      } else {
        this.raw.set(key, target.kind === 'array' ? [value] : value);
      }
      this.sources.set(key, 'config');
    }
    return undefined;
  }

  private readConfig(file: string, depth: number, stack: Set<string>): string | undefined {
    if (depth > 10) return `Config include depth exceeded (10) while processing: ${file}`;
    if (statKind(file) !== 'file') return `Config file not found: ${file}`;
    if (stack.has(file)) return `Circular config include detected: ${file}`;
    stack.add(file);
    const dir = path.dirname(file);

    for (const line of fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''))) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const include = /^\s*@include\s+(.+)$/.exec(line);
      if (include) {
        const target = include[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        const err = this.readConfig(path.resolve(dir, target), depth + 1, stack);
        if (err) return err;
        continue;
      }
      let body: string | undefined;
      if (this.configPrefixes.length === 0) body = line;
      else {
        const prefix = this.configPrefixes.find((p) => line.startsWith(p));
        if (prefix !== undefined) body = line.slice(prefix.length);
      }
      if (body === undefined) continue;
      const eq = body.indexOf('=');
      if (eq < 0) continue;
      const key = body.slice(0, eq).trim().replace(/^--/, '');
      if (!key) continue;
      this.configValues.set(key, { value: body.slice(eq + 1).trim(), dir });
    }
    stack.delete(file);
    return undefined;
  }

  /** Steps 6–9 of the pipeline. Throws with the spec error text. */
  private resolve(): void {
    for (const arg of this.args) {
      if (this.argRaw.has(arg.name)) continue;
      if (arg.variadic) { this.argRaw.set(arg.name, []); continue; }
      if (!arg.defaultValue) throw new Error(`Missing required positional argument: ${arg.name}`);
      this.argRaw.set(arg.name, arg.defaultValue);
    }

    for (const opt of this.options) {
      if (this.sources.has(opt.long)) continue;
      const envValue = opt.kind === 'array' ? undefined : this.env[opt.varName];
      if (envValue) {
        if (opt.kind === 'flag') {
          const b = boolWord(envValue);
          if (b === undefined) throw new Error(`Environment variable ${opt.varName} must be a boolean, got '${envValue}'`);
          this.raw.set(opt.long, String(b));
        } else this.raw.set(opt.long, envValue);
        this.sources.set(opt.long, 'env');
      } else if (opt.kind === 'flag') {
        this.raw.set(opt.long, 'false');
        this.sources.set(opt.long, 'default');
      } else if (opt.defaultValue) {
        this.raw.set(opt.long, opt.defaultValue);
        this.sources.set(opt.long, 'default');
      }
    }

    // Path resolution: base depends on where the value came from.
    for (const opt of this.options) {
      // The config option was already resolved by loadConfig.
      if (!isPathRule(opt.validation) || !this.raw.has(opt.long) || opt.long === this.configOption) continue;
      const src = this.sources.get(opt.long);
      const base = src === 'cli' ? this.cwd
        : src === 'config' ? (this.configValues.get(opt.long) as { dir: string }).dir : this.root;
      const v = this.raw.get(opt.long) as string | string[];
      this.raw.set(opt.long, Array.isArray(v) ? v.map((x) => resolvePath(x, base, opt.searchDirs)) : resolvePath(v, base, opt.searchDirs));
    }
    for (const arg of this.args) {
      if (!isPathRule(arg.validation)) continue;
      const v = this.argRaw.get(arg.name) as string | string[];
      this.argRaw.set(arg.name, Array.isArray(v) ? v.map((x) => resolvePath(x, this.cwd)) : resolvePath(v, this.cwd));
    }

    // Validation and conversion.
    const convert = (v: string, rule: string, name: string): Scalar => (v === '' || !rule ? v : validate(v, rule, name));
    for (const opt of this.options) {
      const v = this.raw.get(opt.long);
      if (v === undefined) this.values[opt.varName] = opt.kind === 'array' ? [] : null;
      else if (opt.kind === 'flag') this.values[opt.varName] = v === 'true';
      else if (Array.isArray(v)) this.values[opt.varName] = v.map((x) => convert(x, opt.validation, `--${opt.long}`));
      else this.values[opt.varName] = convert(v, opt.validation, `--${opt.long}`);
    }
    for (const arg of this.args) {
      const v = this.argRaw.get(arg.name) as string | string[];
      this.values[arg.name] = Array.isArray(v) ? v.map((x) => convert(x, arg.validation, arg.name)) : convert(v, arg.validation, arg.name);
    }
  }

  /**
   * Parse and act like a CLI: handles --help, --help-json-schema and
   * --bash-completion, prints errors and exits on failure. Returns the values.
   */
  run(argv: string[] = process.argv.slice(2)): Record<string, Value> {
    const end = argv.indexOf('--');
    const head = end >= 0 ? argv.slice(0, end) : argv;
    if (head.includes('--help-json-schema')) { this.ensureHelp(); process.stdout.write(this.jsonSchema() + '\n'); process.exit(0); }
    if (head.includes('--bash-completion')) { this.ensureHelp(); process.stdout.write(this.completionData()); process.exit(0); }
    const shellAt = head.indexOf('--completion');
    if (shellAt >= 0) {
      const script = this.completionScript(head[shellAt + 1] ?? '');
      if (script === undefined) die(1, "Unknown shell '%s' (expected bash, zsh or fish)", head[shellAt + 1] ?? '');
      process.stdout.write(script);
      process.exit(0);
    }

    const result = this.parse(argv);
    if (result.status === 'help') {
      process.stdout.write(this.usage());
      process.exit(0);
    }
    if (result.status === 'error') {
      emit('error', result.error, true);
      for (const line of result.detail ?? []) process.stderr.write(line + '\n');
      if (result.showUsage) process.stderr.write(this.usage());
      process.exit(1);
    }
    return this.values;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get(name: string): Value {
    return this.values[name] ?? null;
  }

  /** Where an option's value came from: cli, config, env, default or unset. */
  source(long: string): Source {
    return this.sources.get(long.replace(/^--/, '')) ?? 'unset';
  }

  isSet(long: string): boolean { return this.source(long) === 'cli'; }

  isExplicitlySet(long: string): boolean { return ['cli', 'config', 'env'].includes(this.source(long)); }

  /** Resolved values as JSON (spec section 10). */
  valuesJson(): string {
    const out: Record<string, Value> = {};
    for (const opt of this.options) out[opt.varName] = this.values[opt.varName] ?? null;
    for (const arg of this.args) out[arg.name] = this.values[arg.name] ?? null;
    return JSON.stringify(out, null, 2);
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  private label(opt: OptionDef): string {
    const head = opt.short ? `-${opt.short}, --${opt.long}` : `    --${opt.long}`;
    return opt.kind === 'flag' ? head : `${head}=<value>`;
  }

  /** Help text (spec section 7). */
  usage(): string {
    this.ensureHelp();
    const maxWidth = Number(this.env.CLYOPS_MAX_WIDTH) || 100;
    const longest = Math.max(0, ...this.options.map((o) => this.label(o).length));
    const indent = Math.min(50, Math.max(32, longest + 4));
    const textWidth = Math.max(20, maxWidth - indent);

    const row = (label: string, text: string): string[] => {
      let left = '  ' + label;
      left = left.length < indent ? left.padEnd(indent) : left + ' ';
      const lines = wrapText(text, textWidth);
      return [left + lines[0], ...lines.slice(1).map((l) => ' '.repeat(indent) + l)];
    };
    const annotate = (text: string, notes: string[]) => (notes.length ? `${text} (${notes.join(', ')})` : text);

    const sections: string[][] = [];
    let usageLine = `Usage: ${this.name}`;
    for (const arg of this.args) {
      usageLine += arg.variadic ? ` [<${arg.name}...>]` : arg.defaultValue ? ` [<${arg.name}>]` : ` <${arg.name}>`;
    }
    sections.push([usageLine + ' [OPTIONS]']);

    if (this.description) sections.push(wrapText(this.description, maxWidth));

    if (this.args.length > 0) {
      const lines = ['Positional Arguments:'];
      for (const arg of this.args) {
        const notes: string[] = [];
        if (arg.variadic) notes.push('variadic');
        if (arg.defaultValue) notes.push(`default: ${arg.defaultValue}`);
        if (arg.validation) notes.push(`accepts: ${describeRule(arg.validation)}`);
        lines.push(...row(arg.name, annotate(arg.description, notes)));
      }
      sections.push(lines);
    }

    if (this.commands.length > 0) {
      const lines = ['Required Commands:'];
      for (const c of this.commands) {
        const status = isCommandAvailable(c.command, this.env) ? 'installed' : 'not found';
        lines.push(...row(`${c.command} [${status}]`, c.installHint ? `${c.description} (${c.installHint})` : c.description));
      }
      sections.push(lines);
    }

    const groups = [...new Set(this.options.map((o) => o.group))];
    for (const group of groups) {
      const lines = [`${group}:`];
      for (const opt of this.options.filter((o) => o.group === group)) {
        const notes: string[] = [];
        if (opt.required) notes.push('required');
        if (opt.kind === 'array') notes.push('multiple');
        const cfg = this.configValues.get(opt.long);
        if (cfg) notes.push(`config: ${cfg.value}`);
        if (opt.defaultValue) notes.push(`default: ${opt.defaultValue}`);
        if (opt.validation) notes.push(`accepts: ${describeRule(opt.validation)}`);
        lines.push(...row(this.label(opt), annotate(opt.description, notes)));
      }
      sections.push(lines);
    }

    if (this.epilog) sections.push(this.epilog.replace(/\n+$/, '').split('\n'));

    return sections.map((s) => s.join('\n')).join('\n\n').split('\n').map((l) => l.trimEnd()).join('\n') + '\n';
  }

  /** JSON description of the CLI (spec section 8). */
  jsonSchema(): string {
    const type = (o: OptionDef): string => {
      const v = o.validation;
      if (o.kind === 'flag' || v === 'bool') return 'boolean';
      if (v.startsWith('int') || v === 'port') return 'integer';
      if (v.startsWith('float')) return 'number';
      if (v.startsWith('choice:')) return 'choice';
      if (isPathRule(v)) return 'path';
      return 'string';
    };
    return JSON.stringify({
      clyops: 1,
      script: this.name,
      description: this.description,
      epilog: this.epilog,
      arguments: this.args.map((a) => ({
        name: a.name, description: a.description, required: !a.variadic && !a.defaultValue,
        isVariadic: a.variadic, default: a.defaultValue, validation: a.validation,
      })),
      options: this.options.map((o) => ({
        name: o.long, shortName: o.short, variableName: o.varName, description: o.description,
        default: o.kind === 'flag' ? 'false' : o.defaultValue, group: o.group, type: type(o),
        isFlag: o.kind === 'flag', isArray: o.kind === 'array', required: o.required, validation: o.validation,
        choices: o.validation.startsWith('choice:') ? o.validation.slice(7).split(',') : [],
      })),
      requiredCommands: this.commands.map((c) => ({ command: c.command, description: c.description, installHint: c.installHint })),
    }, null, 2);
  }

  /**
   * Shell script that enables completion for this program (spec section 9):
   * `eval "$(prog --completion bash)"`. Undefined for an unknown shell.
   */
  completionScript(shell: string): string | undefined {
    const template = Object.prototype.hasOwnProperty.call(COMPLETION_SCRIPTS, shell) ? COMPLETION_SCRIPTS[shell] : undefined;
    return template?.split('__CLYOPS_FUNC__').join(this.name.replace(/[^A-Za-z0-9_]/g, '_')).split('__CLYOPS_PROG__').join(this.name);
  }

  /** Tab-separated completion records (spec section 9). */
  completionData(): string {
    const clean = (s: string) => s.replace(/[\t\n]/g, ' ');
    const lines = ['#clyops-completion 1'];
    for (const o of this.options) {
      const noLine = `opt\t--no-${o.long}\t-\tflag\tnone\t-\t${clean(o.description)}`;
      if (o.kind === 'flag') {
        lines.push(`opt\t--${o.long}\t${o.short ? '-' + o.short : '-'}\tflag\tnone\t-\t${clean(o.description)}`, noLine);
        continue;
      }
      const [kind, values] = completionKind(o.validation, o.searchDirs);
      lines.push(`opt\t--${o.long}\t${o.short ? '-' + o.short : '-'}\tvalue\t${kind}\t${values || '-'}\t${clean(o.description)}`);
      if (isBoolLike(o)) lines.push(noLine);
    }
    for (const a of this.args) {
      const [kind, values] = completionKind(a.validation, []);
      lines.push(`arg\t${a.name}\t${a.variadic ? 'variadic' : 'single'}\t${kind}\t${values || '-'}\t${clean(a.description)}`);
    }
    return lines.join('\n') + '\n';
  }
}
