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
  and mapped onto its command line through `--help-json-schema` ([spec §13](../../spec/SPEC.md#13-json-input-toargv)).
- `positionals_order` (optional) is `first` (default) or `last`, for wrappers needing a specific order. `--` is only emitted for positional values starting with `-`.
- `positionals` (optional) lists the tool's positional arguments explicitly; otherwise they're
  options keyed by argument name.
- String values may use `${dot.path}` or `{{dot.path}}` templates against a context you build
  (`job`, `paths`, whatever the trigger knows).
- `artifacts`: glob patterns (`*`, `?`, `**`) relative to `paths.work_dir`, copied into
  `paths.artifacts_dir`, with an optional `required: true` or `min: N`.
- `stdin`: a template naming a file fed to the tool's stdin (`"${media.path}"`; relative to the
  config root). `stdout`: a template naming the file its stdout is written to
  (`"${paths.work_dir}/out.mp3"`; relative to `paths.work_dir`), which also counts as an artifact.
- `result`: a template map added to the result record.

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
`timeoutMs`, `env`, `cwd`, `signal`, `onStderr`. Its `command` shows secret options as `***`.
`configureLogging({module, warn, verbose})` routes warnings about config keys that match no option.

## Job records

```
{ job_id, ...fields, function, status, stage, started_at, updated_at, completed_at, error,
  result_key, history }
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
