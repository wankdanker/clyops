// A directory of tools, loaded with their schemas, and running one with JSON input.
import { watch } from 'node:fs';
import { commands, discover, type Command, type Group } from './discover.js';
import { redactArgv, toArgv, type Input } from './argv.js';
import { start, type RunOptions, type RunResult, type Started } from './run.js';
import { loadSchema, type Schema, type SchemaBody } from './schema.js';

export interface Tool extends Command {
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

export interface ToolResult extends RunResult {
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

function globRegex(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*|\?/g, (m) => (m === '**' ? '.*' : m === '*' ? '[^/]*' : '[^/]'));
  return new RegExp(`^${source}$`);
}

/** Whether `filter` lets `tool` through. */
export function allowed(tool: { words: string[]; schema: SchemaBody }, filter: ToolFilter): boolean {
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
  opts: { name?: string; filter?: ToolFilter; onError?: (cmd: Command, err: Error) => void } = {},
): Promise<{ tree: Group; tools: Tool[] }> {
  const tree = discover(root, { name: opts.name });
  const loaded = await Promise.all(
    commands(tree)
      .filter((cmd) => cmd.kind === 'tool')
      .map(async (cmd) => {
        try {
          return expandCommands(cmd, await loadSchema(cmd.file));
        } catch (err) {
          opts.onError?.(cmd, err as Error);
          return [];
        }
      }),
  );
  const settings: ToolFilter = { allow: tree.allow, deny: tree.deny };
  const tools = loaded.flat().filter((t) => allowed(t, settings) && allowed(t, opts.filter ?? {}));
  return { tree, tools };
}

export interface ToolsWatcher {
  /** The latest tree and tools. */
  current(): { tree: Group; tools: Tool[] };
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
    name?: string;
    filter?: ToolFilter;
    debounceMs?: number;
    onChange?: (loaded: { tree: Group; tools: Tool[] }) => void;
    onError?: (cmd: Command | null, err: Error) => void;
  } = {},
): Promise<ToolsWatcher> {
  const load = () => loadTools(root, { name: opts.name, filter: opts.filter, onError: opts.onError });
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

export interface ToolRunOptions extends RunOptions {
  /** Positionals before or after options (default: first). */
  positionalsOrder?: 'first' | 'last';
  /** Path-valued inputs must resolve inside these directories (see toArgv's `within`). */
  within?: string[];
  /** Pass secret inputs in the environment instead of on the command line (default: true). */
  secretsInEnv?: boolean;
}

/**
 * Start a tool with JSON input (spec section 13). `command` is the command
 * line with secrets shown as `***`. Throws an InputError for input `within`
 * rejects, and for an argument given without an earlier one.
 */
export function startTool(tool: Tool, input: Input, opts: ToolRunOptions = {}): Started & { command: string[] } {
  const { argv, env } = toArgv(tool.schema, input, { within: opts.within, cwd: opts.cwd, secretEnv: opts.secretsInEnv !== false, positionals: opts.positionalsOrder });
  const full = [...(tool.subcommand ?? []), ...argv];
  const started = start(tool.file, full, { ...opts, env: Object.keys(env).length ? { ...(opts.env ?? process.env), ...env } : opts.env });
  const command = [tool.file, ...redactArgv(tool.schema, full)];
  return { ...started, command, result: started.result.then((r) => ({ ...r, command })) };
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
