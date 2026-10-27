# clyops-jobs

Run [clyops](https://github.com/wankdanker/clyops) tools as jobs. Functions are bound to tools in a
JSON config, their options are filled in from templates, the files they produce are collected as
artifacts, and each run gets a job record. A small in-memory queue runs jobs with a concurrency
limit, for servers that hand out job ids. Built on [clyops-tools](../tools).

```sh
pnpm add clyops-jobs
```

**Single file.** `clyops-jobs.cjs` (in this package, and on npm) is the whole library as one dependency-free
CommonJS file: copy or link it into a project and `require()` it on Node 20+, with no build step
and no `node_modules`. It includes clyops-tools. `require('clyops-jobs')` loads it; `import` loads the ESM build. It is generated from the sources and checked in CI.

## Function config

```json
{
  "functions": {
    "transcribe": { "key": "asr", "script": "scripts/transcribe.sh",
                    "artifacts": { "include": ["${job.id}/*.vtt"], "required": true },
                    "result": { "captions": "${job.id}/out.vtt" } }
  },
  "defaults": { "asr": { "model": "base", "threads": 4 } },
  "asr":      { "model": "large", "out_dir": "${paths.work_dir}/${job.id}" }
}
```

- `functions.NAME.script` is the tool, relative to a script root.
- `key` names the options block (default: the function name). Options are
  `deepMerge(defaults[key], config[key])`, keyed like the tool's options (`out_dir`, `out-dir`)
  and mapped onto its command line through `--help-json-schema` ([spec §13](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md#13-json-input-toargv)).
- `positionals_order` (optional) is `first` (default) or `last`, for wrappers needing a specific order. `--` is only emitted for positional values starting with `-`.
- `positionals` (optional) lists the tool's positional arguments explicitly; otherwise they're
  options keyed by argument name.
- String values may use `${dot.path}` or `{{dot.path}}` templates against a context you build
  (`job`, `paths`, whatever the trigger knows). An unknown path is an error, so a typo fails
  loudly, except under `params` (the caller's fields): an option or positional that names a
  missing or null `params` field is left unset, so the tool's default applies. That holds for
  `${params.x}` alone and inside a longer string (`v-${params.x}`), so a value is never half
  filled. Elsewhere (`result`, `stdin`, `stdout`, artifact patterns) a missing field renders as
  `''`. `strict_params: true` on a function makes a missing `params` field an error too.
- `artifacts`: glob patterns (`*`, `?`, `**`) relative to `paths.work_dir`, copied into
  `paths.artifacts_dir`, with an optional `required: true` or `min: N`.
- `stdin`: a template naming a file fed to the tool's stdin (`"${media.path}"`; relative to the
  config root). `stdout`: a template naming the file its stdout is written to
  (`"${paths.work_dir}/out.mp3"`; relative to `paths.work_dir`), which also counts as an artifact.
- `result`: a template map added to the result record.

### Steps

A function can run several tools in order instead of one `script`, so a definition chains
tools that already exist (fetch some JSON, download what it names, process the file):

```json
{
  "functions": {
    "fingerprint": {
      "steps": [
        { "name": "fetch",    "script": "tools/http-get-json" },
        { "name": "download", "script": "tools/download", "stdout": "${job.id}/media" },
        { "name": "fp",       "script": "tools/media-to-fp", "stdin": "${steps.download.stdout}" }
      ],
      "artifacts": { "include": ["${job.id}/*.fp"], "required": true },
      "result": { "size": "${steps.fetch.result.size}" }
    }
  },
  "fetch":    { "url": "https://media.example.com/recording/${params.uuid}", "token": "${secrets.token}" },
  "download": { "url": "${steps.fetch.result.signedUrl}" }
}
```

- Each step is a binding like a function: `name` (letters, digits, `_`, `-`), `script`, and
  optionally `key` (its options block, default the step name), `positionals`,
  `positionals_order`, `stdin`, `stdout` and `strict_params` (default the function's).
  `artifacts` and `result` belong to the function, as do the caller-input rules: a caller
  reaches a step only through `params` fields its options name.
- Every step shares the context, `paths.work_dir` included, so files pass by path. A step's
  outputs are `steps.NAME` in the templates after it: `exit_code`; `stdout`, the path of its
  `stdout` file or else its collected output without trailing newlines; `result`, its
  `result` role or else its collected stdout parsed as JSON; `meta`; `progress`. A
  `${steps...}` path that isn't there, such as a later step or a field the JSON lacks, is an
  error naming the step.
- `previous` is the step that ran just before, on whichever path led here, with the same
  fields plus its `name`: a handler several branches share reads `${previous.name}`,
  `${previous.exit_code}`, `${previous.result.field}` or, after an `error` branch,
  `${previous.error}`. The first step has none, so naming it there is an error.
- After a step that succeeds the chain goes on to the next step, or ends after the last one.
  A step that exits nonzero, times out or is stopped ends the chain; the run is that step's,
  with `failedStep` naming it. A step that can't start (a template, stdin or schema error)
  rejects the run. `continue_on_exit: [2]` on a step makes those codes a success, and the
  chain then exits with the first of them (a partial result).
- Branches change where a step leads: `succeed`, `fail` (a nonzero exit or timeout) and
  `error` (it couldn't start) each name a later step, and `succeed: "$end"` ends the chain.
  Branches only go forward, so a chain always ends. A step reached only through a branch,
  such as a fallback or a cleanup, still sits in the list, so the step before it usually
  needs a `succeed`. The chain's exit code is its last step's: a fallback that succeeds
  makes the job succeed, and a cleanup that should leave it failed exits nonzero. A step
  that took its `error` branch is `steps.NAME.error` (the message), with `exit_code: null`.
  A cancelled chain, or one out of time, takes no branch.

  ```json
  "steps": [
    { "name": "fetch",    "script": "tools/http-get-json", "fail": "mirror", "succeed": "process" },
    { "name": "mirror",   "script": "tools/http-get-json" },
    { "name": "process",  "script": "tools/media-to-fp" }
  ]
  ```
- `timeoutMs` limits the whole chain and a step's `timeout_ms` that step; `signal` stops the
  running step. `onProgress` gets each step's updates with `step` and a default `stage`.
- The run is the last step's, plus `steps` (the outputs by name), `previous` (the last step)
  and `stepRuns`. Render artifacts and the result with them through `runContext(context,
  run)`, so a result map can use `${previous...}` whichever branch the chain ended on.
- `functionParamNames(fn)` lists the `params` fields a function's templates use, steps
  included, for describing its caller inputs.

```js
import { resolveFunctionConfig, runScriptFunction, copyConfiguredArtifacts, buildResultRecord,
         newJobId, newJobRecord, transitionJobRecord, timestampIso } from 'clyops-jobs';

const fn = resolveFunctionConfig('/srv/tools', config, 'transcribe');
const jobId = newJobId('transcribe');
const context = { job: { id: jobId }, paths: { work_dir: '/srv/work', artifacts_dir: `/srv/done/${jobId}` } };
let record = newJobRecord({ jobId, functionName: 'transcribe' });

record = transitionJobRecord(record, { status: 'processing', stage: 'run' });
const run = await runScriptFunction(fn, { configRoot: '/srv/config', context, timeoutMs: 600_000 });
if (run.exitCode !== 0) throw new Error(run.stderrTail.join('\n'));
const artifacts = copyConfiguredArtifacts(fn, context);
const result = buildResultRecord({ jobId, fn, artifactKeys: artifacts.map((a) => a.key), context, now: timestampIso() });
record = transitionJobRecord(record, { status: 'done', completedAt: timestampIso() });
```

`runScriptFunction` options: `configRoot` (relative path options resolve against it),
`context`, `controlled` (options the trigger sets itself, default `['help']`), `defaultPositional`
(a template for the first argument when the config gives none, e.g. `'${media.path}'`),
`timeoutMs`, `killGraceMs`, `env`, `cwd`, `signal`, `onStderr`, `onProgress`, `onLog`. Its `command` shows secret options as `***`.

When the tool declares the well-known [roles](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md#14-roles-on-file-descriptors),
the run wires them up: each `progress` object goes to `onProgress` (and the last one is the run's
`progress`), `log` lines to `onLog`, and the `meta` document is parsed into the run's `meta`.
The run's `result` is the `result` role parsed as JSON, or else the collected stdout when it is JSON.
`updateJobProgress(record, update)` puts an update on a record as `progress` (and its `stage`, if
any) without a history entry; the queue's tasks get it as `progress(update)`:

```js
queue.add('transcribe', ({ signal, progress }) => runScriptFunction(fn, { configRoot, context, signal, onProgress: progress }));
```
`configureLogging({module, warn, verbose})` routes warnings about config keys that match no option.

## Job records

```
{ job_id, ...fields, function, status, stage, started_at, updated_at, completed_at, error,
  result_key, progress?, history }
```

`status` moves `pending` → `processing` → `done` | `error`. `newJobId(seed, prefix = 'job')`,
`newJobRecord` and `transitionJobRecord` are pure: where records are kept is up to you.

## Queue

```js
import { JobQueue } from 'clyops-jobs';

const queue = new JobQueue({ concurrency: 4, keep: 1000, onChange: (record) => save(record), onDrop: (record) => cleanUp(record) });
const job = queue.add('transcribe', async ({ signal, stage }) => { stage('decode'); return doWork(signal); });
job.record;        // the live record
await job.done;    // the task's result (rejects if it failed)
queue.get(job.record.job_id)?.cancel();
```

ESM only, Node 20+.

A missing or unreadable configured stdin file rejects `runScriptFunction()`
with its input-file error. It fails that job and stops its tool; the host worker
stays alive.

## Documentation

Read the [Node guide](https://clyops.io/node-tools.html) and
[complete public API reference](https://clyops.io/reference/node/index.html).
Type declarations and documentation comments are included in the package.
