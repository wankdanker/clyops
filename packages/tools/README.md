# clyops-tools

Work with a directory of [clyops](https://github.com/wankdanker/clyops) tools from Node: find them,
read their schemas, turn a JSON object into a command line, and run them. It is the shared core of
the clyops API server, MCP server and job engine, and has no dependencies.

```sh
npm install clyops-tools
```

**Single file.** `clyops-tools.cjs` (in this package, and on npm) is the whole library as one dependency-free
CommonJS file: copy or link it into a project and `require()` it on Node 20+, with no build step
and no `node_modules`. `require('clyops-tools')` loads it; `import` loads the ESM build. It is generated from the sources and checked in CI.

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
| `loadTools(root, {name?, filter?, onError?})` | `{tree, tools}`: the tree, plus every `tool` with its schema loaded. A program's commands become tools of their own (`expandCommands`); `filter` and the root `.clyops` `allow`/`deny` keys leave tools out (`allowed`). |
| `watchTools(root, {name?, filter?, debounceMs?, onChange?, onError?})` | `loadTools`, then reload on every change under the directory. `current()` is the latest set; `close()` stops watching. |
| `runTool(tool, input, runOptions?)` | `toArgv` + `run`, with `ok` and `json` (stdout parsed, when it is JSON). Secret options go in the environment (`secretsInEnv: false` keeps them on the command line) and `command` shows them as `***`; `within` confines path inputs. |
| `startTool(tool, input, runOptions?)` | The same, started: `{child, stdout, result, command}`, to stream stdout. |
| `expandCommands(cmd, schema)` | A program's commands ([spec §1.7](../../spec/SPEC.md#17-commands)) as tools: words, `subcommand`, and the command's schema with the options it inherits. |
| `allowed(tool, {allow?, deny?, readOnly?})` | Whether a filter lets a tool through: globs over its words joined by `/` (`*` within a word, `**` across). |
| `commands(group)` | Every command in a tree. |
| `classify(file)` | `tool`, `dispatcher` or `other`. Only `tool`s should be run for their schema. |
| `loadSchema(file, {cwd?, timeoutMs?})` | The tool's `--help-json-schema` output, cached by file modification time and size. |
| `toArgv(schema, input, {base?, render?, controlled?, positionals?, secretEnv?, within?, cwd?})` | JSON input → argv ([spec §13](../../spec/SPEC.md#13-json-input-toargv)). Returns `{argv, env, unknown, controlled}`; with `secretEnv` secrets are in `env`. With `within`, a path input outside those directories throws an `InputError` (`status` 400). |
| `toJsonSchema(schema)` | The JSON Schema of that input: secrets `writeOnly`, exclusive options as `allOf`/`not`. |
| `run(file, argv, {cwd?, env?, timeoutMs?, signal?, onStdout?, onStderr?, stdin?, stdout?, maxOutput?})` | Run a tool and collect its output. `stdin` is a string, Buffer or stream; `stdout: 'buffer'` keeps binary output in `stdoutBuffer`; `maxOutput` caps what is kept (`truncated`). |
| `start(file, argv, options)` | `run`, started: `{child, stdout, result}`; with `stdout: 'stream'` read stdout as it comes. |
| `redactArgv(schema, argv)`, `checkWithin(name, value, dirs, base)` | Secrets as `***`; the path confinement check. |
| `auditLog(target)`, `isTextType(contentType)` | A JSON-lines audit writer (a file, or `-` for stderr); whether declared output is text. |
| `tail(text, lines?)`, `shellQuote(argv)` | Helpers for error messages and logs. |

ESM only, Node 20+.
