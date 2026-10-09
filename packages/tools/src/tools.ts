// A directory of tools, loaded with their schemas, and running one with JSON input.
import { watch } from 'node:fs';
import { commands, discover, type Command, type Group } from './discover.js';
import { toArgv, type Input } from './argv.js';
import { run, type RunOptions, type RunResult } from './run.js';
import { loadSchema, type Schema } from './schema.js';

export interface Tool extends Command {
  schema: Schema;
  /** The first line of its description. */
  description: string;
}

export interface ToolResult extends RunResult {
  ok: boolean;
  /** stdout parsed as JSON, when it is JSON. */
  json?: unknown;
}

/** The clyops tools under `root` with their schemas. Tools whose schema can't be read are skipped. */
export async function loadTools(root: string, opts: { name?: string; onError?: (cmd: Command, err: Error) => void } = {}): Promise<{ tree: Group; tools: Tool[] }> {
  const tree = discover(root, { name: opts.name });
  const loaded = await Promise.all(
    commands(tree)
      .filter((cmd) => cmd.kind === 'tool')
      .map(async (cmd) => {
        try {
          const schema = await loadSchema(cmd.file);
          return { ...cmd, schema, description: schema.description.split('\n')[0] };
        } catch (err) {
          opts.onError?.(cmd, err as Error);
          return undefined;
        }
      }),
  );
  return { tree, tools: loaded.filter((t): t is Tool => Boolean(t)) };
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
 * fails keeps the previous set and is reported to `onError`. Needs Node 20+
 * (recursive fs.watch) on Linux.
 */
export async function watchTools(
  root: string,
  opts: { name?: string; debounceMs?: number; onChange?: (loaded: { tree: Group; tools: Tool[] }) => void; onError?: (cmd: Command | null, err: Error) => void } = {},
): Promise<ToolsWatcher> {
  const load = () => loadTools(root, { name: opts.name, onError: opts.onError });
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

/** Run a tool with JSON input (spec section 13). */
export async function runTool(tool: Tool, input: Input, opts: RunOptions = {}): Promise<ToolResult> {
  const result = await run(tool.file, toArgv(tool.schema, input).argv, opts);
  const out: ToolResult = { ...result, ok: result.exitCode === 0 };
  try {
    if (result.stdout.trim()) out.json = JSON.parse(result.stdout);
  } catch {
    // not JSON: stdout is still there as text
  }
  return out;
}
