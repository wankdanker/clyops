# clyops-tools

Work with a directory of [clyops](https://github.com/wankdanker/clyops) tools from Node: find them,
read their schemas, turn a JSON object into a command line, and run them. It is the shared core of
the clyops API server, MCP server and job engine, and has no dependencies.

```sh
npm install clyops-tools
```

```js
import { discover, commands, loadSchema, toArgv, toJsonSchema, run } from 'clyops-tools';

const tree = discover('./scripts');                  // groups and commands, as clyops-dispatch sees them
for (const cmd of commands(tree).filter((c) => c.kind === 'tool')) {
  const schema = await loadSchema(cmd.file);         // --help-json-schema, cached until the file changes
  console.log(cmd.words.join(' '), toJsonSchema(schema));
}

const schema = await loadSchema('./scripts/media/to-pcm.sh');
const { argv, unknown } = toArgv(schema, { input: 'in.wav', rate: 16000, verbose: true });
// argv: ['--rate', '16000', '--verbose', '--', 'in.wav']
const result = await run('./scripts/media/to-pcm.sh', argv, { timeoutMs: 60_000 });
// { exitCode, signal, timedOut, stdout, stderr, durationMs, command }
```

| Function | |
| --- | --- |
| `discover(root, {name?})` | The tree of groups and commands under a directory or a dispatcher definition file ([spec §12](../../spec/SPEC.md#12-dispatchers-clyops-dispatch)): `.clyops` descriptions and ignore lists, hidden files skipped, groups shadowing commands. Nested dispatchers are expanded into groups. Each command has a `kind`: `tool` (uses a clyops library), `dispatcher` or `other`. |
| `loadTools(root, {name?, onError?})` | `{tree, tools}`: the tree, plus every `tool` with its schema loaded. |
| `watchTools(root, {name?, debounceMs?, onChange?, onError?})` | `loadTools`, then reload on every change under the directory. `current()` is the latest set; `close()` stops watching. Node 20+ on Linux. |
| `runTool(tool, input, runOptions?)` | `toArgv` + `run`, with `ok` and `json` (stdout parsed, when it is JSON). |
| `commands(group)` | Every command in a tree. |
| `classify(file)` | `tool`, `dispatcher` or `other`. Only `tool`s should be run for their schema. |
| `loadSchema(file, {cwd?, timeoutMs?})` | The tool's `--help-json-schema` output, cached by file modification time and size. |
| `toArgv(schema, input, {base?, render?, controlled?, positionals?})` | JSON input → argv ([spec §13](../../spec/SPEC.md#13-json-input-toargv)). Returns `{argv, unknown, controlled}`. |
| `toJsonSchema(schema)` | The JSON Schema of that input. |
| `run(file, argv, {cwd?, env?, timeoutMs?, signal?, onStdout?, onStderr?})` | Run a tool and collect its output. |
| `tail(text, lines?)`, `shellQuote(argv)` | Helpers for error messages and logs. |

ESM only, Node 18+.
