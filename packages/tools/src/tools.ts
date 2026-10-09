// A directory of tools, loaded with their schemas, and running one with JSON input.
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
