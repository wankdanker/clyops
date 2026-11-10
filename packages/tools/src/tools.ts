// A directory of tools, loaded with their schemas, and running one with JSON input.
import { watch } from 'node:fs';
import { commands, discover, type Command, type Group } from './discover.js';
import { InputError, inputKeys, isPathValued, redactArgv, toArgv, type Input } from './argv.js';
import { start, type RoleOption, type RunOptions, type RunResult, type Started } from './run.js';
import { loadSchema, PROBE_TIMEOUT_MS, type Schema, type SchemaBody } from './schema.js';
import { fetchSchemaRefs, type SchemaFetchOptions } from './fetch-schemas.js';

/** A probed executable or leaf command, with its effective inherited schema. */
export interface Tool extends Command {
  /** Effective schema returned by the executable and inherited command options. */
  schema: Schema;
  /** The first line of its description. */
  description: string;
  /**
   * For a command of a program (spec section 1.7), its words, given to the
   * program before the options: `db migrate`. `schema` is then the command's,
   * with the options it inherits.
   */
  subcommand?: string[];
}

/** Tool execution outcome, including success and parsed JSON output when available. */
export interface ToolResult extends RunResult {
  /** Whether the tool finished without timeout, signal, or a nonzero exit code. */
  ok: boolean;
  /** stdout parsed as JSON, when it is JSON. */
  json?: unknown;
}

/** Which tools to serve. Patterns are globs over a tool's words joined by `/`: `*` within a word, `**` across them. */
export interface ToolFilter {
  /** Serve only tools matching one of these (default: all). */
  allow?: string[];
  /** Leave out tools matching one of these. */
  deny?: string[];
  /** Serve only tools declaring the `read-only` effect. */
  readOnly?: boolean;
}

/**
 * Which inputs a server takes from its callers (spec section 13, server-set inputs). A network
 * server applies one; a local one may.
 */
export interface InputPolicy {
  /** Path inputs are confined to directories (`within`): they are then open, and confined; else closed. */
  confined: boolean;
  /** Callers may set `file:executable` inputs, choosing what runs (default: no). */
  allowExecutables?: boolean;
}

/** The options and arguments of `schema` a caller may not set under `policy`: their names. */
export function closedInputs(schema: SchemaBody, policy: InputPolicy): string[] {
  const closed = (validation: string, type?: string) =>
    validation === 'file:executable' ? !policy.allowExecutables : isPathValued(validation, type) && !policy.confined;
  return [
    ...schema.options.filter((o) => o.name !== 'help' && closed(o.validation, o.type)).map((o) => o.name),
    ...schema.arguments.filter((a) => closed(a.validation)).map((a) => a.name),
  ];
}

/** `schema` as callers see it: without the `closed` options and arguments. */
export function publicSchema<S extends SchemaBody>(schema: S, closed: string[]): S {
  if (!closed.length) return schema;
  return {
    ...schema,
    options: schema.options.filter((o) => !closed.includes(o.name)),
    arguments: schema.arguments.filter((a) => !closed.includes(a.name)),
  };
}

/** The keys of `input` that set one of the `closed` options or arguments. */
export function closedKeys(schema: SchemaBody, closed: string[], input: Record<string, unknown>): string[] {
  return [...schema.options, ...schema.arguments]
    .filter((item) => closed.includes(item.name))
    .flatMap((item) => inputKeys(item).filter((key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== null && input[key] !== undefined));
}

/** The required argument a caller would have to give but may not, so the tool can't be served; or none. */
export function closedRequirement(schema: SchemaBody, closed: string[]): string | undefined {
  return schema.arguments.find((a) => a.required && closed.includes(a.name))?.name;
}

/** Schema probes `loadTools` runs at the same time by default. */
export const PROBE_CONCURRENCY = 8;

// `fn` over `items`, at most `limit` at a time, results in order. A limit that isn't a positive
// number means the default; Infinity means all at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const n = limit === Infinity ? items.length : Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : PROBE_CONCURRENCY;
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function globRegex(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*|\?/g, (m) => (m === '**' ? '.*' : m === '*' ? '[^/]*' : '[^/]'));
  return new RegExp(`^${source}$`);
}

/** Whether `filter` lets `tool` through. */
export function allowed(tool: { /** Command words relative to the discovered root. */ words: string[]; /** Effective schema returned by the executable and inherited command options. */ schema: SchemaBody }, filter: ToolFilter): boolean {
  const path = tool.words.join('/');
  if (filter.allow?.length && !filter.allow.some((p) => globRegex(p).test(path))) return false;
  if (filter.deny?.some((p) => globRegex(p).test(path))) return false;
  return !filter.readOnly || Boolean(tool.schema.effects?.includes('read-only'));
}

/**
 * A program's commands (spec section 1.7) as tools of their own, one per
 * command without commands: words `[...cmd.words, 'db', 'migrate']`, and a
 * schema with the command's options followed by those it inherits, the
 * nearest declared effects, stdin and stdout, and every relationship and
 * required command along the way. A program without commands is one tool.
 */
export function expandCommands(cmd: Command, schema: Schema): Tool[] {
  const describe = (s: SchemaBody) => s.description.split('\n')[0];
  if (!schema.commands?.length) return [{ ...cmd, schema, description: describe(schema) }];
  const out: Tool[] = [];
  const visit = (chain: SchemaBody[], words: string[]) => {
    const node = chain[chain.length - 1];
    if (node.commands?.length) {
      for (const child of node.commands) visit([...chain, child], [...words, child.name]);
      return;
    }
    const nearest = <T>(pick: (s: SchemaBody) => T | undefined | null, empty: (v: T) => boolean = () => false) => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const v = pick(chain[i]);
        if (v !== undefined && v !== null && !empty(v)) return v;
      }
      return undefined;
    };
    const flat: Schema = {
      clyops: schema.clyops,
      script: [schema.script, ...words].join(' '),
      description: node.description,
      epilog: node.epilog,
      arguments: node.arguments,
      options: [...chain].reverse().flatMap((s) => s.options),
      requiredCommands: chain.flatMap((s) => s.requiredCommands),
      effects: nearest((s) => s.effects, (v) => v.length === 0) ?? [],
      constraints: chain.flatMap((s) => s.constraints ?? []),
      stdin: nearest((s) => s.stdin) ?? null,
      stdout: nearest((s) => s.stdout) ?? null,
      // The nearest declaration of each role name wins (spec section 14).
      roles: [...new Map(chain.flatMap((s) => s.roles ?? []).map((r) => [r.name, r])).values()],
      commands: [],
    };
    out.push({ ...cmd, name: words[words.length - 1], words: [...cmd.words, ...words], schema: flat, description: describe(node), subcommand: words });
  };
  visit([schema], []);
  return out;
}

/**
 * The clyops tools under `root` with their schemas, a program's commands
 * expanded into tools of their own. Tools whose schema can't be read are
 * skipped, as are tools `filter` or the root's `allow`/`deny` settings leave
 * out (both must let a tool through).
 */
export async function loadTools(
  root: string,
  opts: {
    /** Program, command, option, or argument name as declared in its containing type. */
    name?: string;
    filter?: ToolFilter;
    onError?: (cmd: Command, err: Error) => void;
    /** Schema probes run at the same time (default `PROBE_CONCURRENCY`). */
    concurrency?: number;
    /** How long each probe may take, in milliseconds (default `PROBE_TIMEOUT_MS`). */
    timeoutMs?: number;
    /** How the URL schemas `json:SCHEMA` inputs reference are fetched (on by default); a failed fetch goes to `onError` and leaves the input unchecked. */
    schemas?: SchemaFetchOptions;
  } = {},
): Promise<{ /** Discovered directory tree. */ tree: Group; /** Discovered, schema-loaded tools offered by the server. */ tools: Tool[] }> {
  const tree = discover(root, { name: opts.name });
  // A few probes at a time, each with room to start: on a busy host, probing a hundred tools at
  // once times healthy ones out.
  const loaded = await mapLimit(commands(tree).filter((cmd) => cmd.kind === 'tool'), opts.concurrency ?? PROBE_CONCURRENCY, async (cmd) => {
    try {
      const schema = await loadSchema(cmd.file, { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS });
      return expandCommands(cmd, await fetchSchemaRefs(schema, opts.schemas, (err) => opts.onError?.(cmd, err)));
    } catch (err) {
      opts.onError?.(cmd, err as Error);
      return [];
    }
  });
  const settings: ToolFilter = { allow: tree.allow, deny: tree.deny };
  const tools = loaded.flat().filter((t) => allowed(t, settings) && allowed(t, opts.filter ?? {}));
  return { tree, tools };
}

/** A tools-directory watcher. Call close to stop watching and release filesystem handles. */
export interface ToolsWatcher {
  /** The latest tree and tools. */
  current(): { /** Discovered directory tree. */ tree: Group; /** Discovered, schema-loaded tools offered by the server. */ tools: Tool[] };
  /** Stop watching directories and cancel the pending reload timer. */
  close(): void;
}

/**
 * loadTools, then reload whenever something under the tools directory
 * changes, calling `onChange` when the set of tools (or their schemas or
 * descriptions) differs. Changes are debounced, so a
 * burst of writes (an editor saving, a checkout) reloads once. A reload that
 * fails keeps the previous set and is reported to `onError`.
 */
export async function watchTools(
  root: string,
  opts: {
    /** Program, command, option, or argument name as declared in its containing type. */
    name?: string;
    filter?: ToolFilter;
    debounceMs?: number;
    /** Schema probes run at the same time (see `loadTools`). */
    concurrency?: number;
    /** How long each probe may take, in milliseconds (see `loadTools`). */
    timeoutMs?: number;
    /** How URL schemas are fetched (see `loadTools`). */
    schemas?: SchemaFetchOptions;
    onChange?: (loaded: { /** Discovered directory tree. */ tree: Group; /** Discovered, schema-loaded tools offered by the server. */ tools: Tool[] }) => void;
    onError?: (cmd: Command | null, err: Error) => void;
  } = {},
): Promise<ToolsWatcher> {
  const load = () => loadTools(root, { name: opts.name, filter: opts.filter, onError: opts.onError, concurrency: opts.concurrency, timeoutMs: opts.timeoutMs, schemas: opts.schemas });
  let loaded = await load();
  let timer: NodeJS.Timeout | undefined;
  // Reloads run one at a time; a change during one schedules another.
  let running: Promise<void> = Promise.resolve();
  const reload = () => {
    running = running.then(async () => {
      try {
        const next = await load();
        // Files that aren't tools change too (a tool's output, a log): only
        // report a set that differs.
        if (JSON.stringify(next) === JSON.stringify(loaded)) return;
        loaded = next;
        opts.onChange?.(loaded);
      } catch (err) {
        opts.onError?.(null, err as Error);
      }
    });
  };
  const watcher = watch(loaded.tree.dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(reload, opts.debounceMs ?? 250);
  });
  return {
    current: () => loaded,
    close: () => {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

/** Process execution options combined with JSON-to-argv mapping and path restrictions. */
export interface ToolRunOptions extends RunOptions {
  /** Positionals before or after options (default: first). */
  positionalsOrder?: 'first' | 'last';
  /** Path-valued inputs must resolve inside these directories (see toArgv's `within`). */
  within?: string[];
  /** Pass secret inputs in the environment instead of on the command line (default: true). */
  secretsInEnv?: boolean;
  /** Options and arguments the caller may not set (see `closedInputs`); input setting one is an InputError. */
  closed?: string[];
}

/**
 * Start a tool with JSON input (spec section 13). `command` is the command
 * line with secrets shown as `***`. Throws an InputError for input `within`
 * rejects, for a `closed` input, and for an argument given without an earlier one.
 */
export function startTool(tool: Tool, input: Input, opts: ToolRunOptions = {}): Started & { /** Executed command words, including executable and arguments. */ command: string[] } {
  const { argv, env, controlled } = toArgv(tool.schema, input, {
    within: opts.within, cwd: opts.cwd, secretEnv: opts.secretsInEnv !== false, positionals: opts.positionalsOrder, controlled: opts.closed,
  });
  if (controlled.length) throw new InputError(`${controlled.join(', ')}: set by the server, not by callers`);
  const full = [...(tool.subcommand ?? []), ...argv];
  const roles = opts.roles && declaredRoles(tool, opts.roles);
  const started = start(tool.file, full, { ...opts, roles, env: Object.keys(env).length ? { ...(opts.env ?? process.env), ...env } : opts.env });
  const command = [tool.file, ...redactArgv(tool.schema, full)];
  return { ...started, command, result: started.result.then((r) => ({ ...r, command })) };
}

/** How long `completeValues` lets a tool answer (spec section 13), unless told otherwise. */
export const VALUES_TIMEOUT_MS = 10_000;

/** Options for `completeValues`: what to list, and how to run the tool as for `runTool`. */
export interface CompleteValuesOptions extends Pick<ToolRunOptions, 'cwd' | 'env' | 'timeoutMs' | 'signal' | 'within' | 'positionalsOrder' | 'secretsInEnv' | 'closed'> {
  /** The text being completed (default: empty). */
  prefix?: string;
  /** The most values to return, at least 1 (default: 100). */
  limit?: number;
  /** How many matching values to skip (default: 0). */
  offset?: number;
}

/** A page of an input's values (spec section 9.3). */
export interface ValuesPage {
  /** The values, at most the limit asked for. */
  values: string[];
  /** Whether values beyond the limit were left out. */
  more: boolean;
}

/** A tool that couldn't list values: it failed, timed out or answered something else (HTTP status 502). */
export class ValuesError extends Error {
  /** HTTP status used by adapters to report a failing tool. */
  status = 502;
}

/**
 * List the values of a dynamic input (spec sections 9.3 and 13): `key` is its
 * input key, `input` the other inputs given so far. Inputs that can't be
 * placed on a command line yet (an argument after a missing one) and closed
 * inputs are left out. Throws an InputError when the input isn't dynamic, is
 * closed or the limit is out of range, and a ValuesError when the tool fails.
 */
export async function completeValues(tool: Tool, key: string, input: Input = {}, opts: CompleteValuesOptions = {}): Promise<ValuesPage> {
  const { schema } = tool;
  const item = [...schema.options.filter((o) => o.name !== 'help'), ...schema.arguments].find((i) => inputKeys(i).includes(key));
  if (!item || !item.dynamic) throw new InputError(`${key} has no values to list`);
  if (opts.closed?.includes(item.name)) throw new InputError(`${key}: set by the server, not by callers`);
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1) throw new InputError('limit must be an integer of at least 1');
  if (!Number.isInteger(offset) || offset < 0) throw new InputError('offset must be a non-negative integer');
  const own = new Set(inputKeys(item));
  const others = Object.fromEntries(Object.entries(input).filter(([k]) => !own.has(k)));
  const argvOptions = { within: opts.within, cwd: opts.cwd, secretEnv: opts.secretsInEnv !== false, positionals: opts.positionalsOrder, controlled: opts.closed };
  let built;
  try {
    built = toArgv(schema, others, argvOptions);
  } catch (err) {
    if (err instanceof InputError) throw err;
    // An argument given after a missing one: list without the arguments.
    const argKeys = new Set(schema.arguments.flatMap((a) => inputKeys(a)));
    built = toArgv(schema, Object.fromEntries(Object.entries(others).filter(([k]) => !argKeys.has(k))), argvOptions);
  }
  const words = [...(tool.subcommand ?? []), ...built.argv];
  const env = Object.keys(built.env).length ? { ...(opts.env ?? process.env), ...built.env } : opts.env;
  const result = await start(tool.file, ['--complete-values', item.name, opts.prefix ?? '', String(limit), String(offset), '--', ...words], {
    cwd: opts.cwd, env, signal: opts.signal, timeoutMs: opts.timeoutMs ?? VALUES_TIMEOUT_MS,
  }).result;
  const said = result.stderr.trim().split('\n').pop()?.replace(/^\S+ \S+ \[[^\]]*\] /, '') ?? '';
  if (result.timedOut) throw new ValuesError(`${tool.words.join(' ')} took too long to list values`);
  if (result.exitCode !== 0) throw new ValuesError(said || `${tool.words.join(' ')} failed to list values`);
  let page: unknown;
  try { page = JSON.parse(result.stdout); } catch { page = undefined; }
  const ok = (p: unknown): p is ValuesPage => typeof p === 'object' && p !== null && Array.isArray((p as ValuesPage).values) &&
    (p as ValuesPage).values.every((v) => typeof v === 'string') && typeof (p as ValuesPage).more === 'boolean';
  if (!ok(page)) throw new ValuesError(`${tool.words.join(' ')} answered --complete-values with something other than a page of values`);
  return { values: page.values, more: page.more };
}

/**
 * The requested roles a tool declares in that direction (an input role needs `input`); the rest are
 * dropped, so a runner can ask every tool for `progress` and only wire it where it exists.
 */
export function declaredRoles(tool: { /** Effective schema returned by the executable and inherited command options. */ schema: SchemaBody }, requested: Record<string, RoleOption>): Record<string, RoleOption> {
  const declared = new Map((tool.schema.roles ?? []).map((r) => [r.name, r.direction]));
  return Object.fromEntries(Object.entries(requested).filter(([name, role]) =>
    declared.get(name) === (role.input === undefined ? 'out' : 'in')));
}

/** Run a tool with JSON input (spec section 13), collecting its output. */
export async function runTool(tool: Tool, input: Input, opts: ToolRunOptions = {}): Promise<ToolResult> {
  if (opts.stdout === 'stream') throw new Error("runTool() collects stdout; use startTool() for stdout: 'stream'");
  const result = await startTool(tool, input, opts).result;
  const out: ToolResult = { ...result, ok: result.exitCode === 0 && !result.timedOut && !result.signal };
  try {
    if (result.stdout.trim()) out.json = JSON.parse(result.stdout);
  } catch {
    // not JSON: stdout is still there as text
  }
  return out;
}
