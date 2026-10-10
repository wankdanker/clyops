import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JobQueue, buildFunctionCommand, buildResultRecord, configureLogging, copyConfiguredArtifacts, deepMerge, findFilesByArtifactPattern,
  globToRegex, newJobId, newJobRecord, renderConfigValue, renderResultMap, renderTemplateString, resolveConfigPath, resolveFunctionConfig,
  runScriptFunction, transitionJobRecord,
} from '../dist/index.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const env = { PATH: process.env.PATH, KEY: 'k' };

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-jobs-')));
  mkdirSync(join(root, 'scripts'));
  const demo = join(root, 'scripts/demo.sh');
  writeFileSync(demo, `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/demo.cjs')} "$@"\n`);
  chmodSync(demo, 0o755);
  return root;
}

const warnings = [];
configureLogging({ module: 'test', warn: (fmt, ...args) => warnings.push([fmt, ...args].join(' ')) });

test('templates', () => {
  const ctx = { job: { id: 'j1' }, media: { path: '/in/a.wav', meta: { rate: 16000 } }, empty: null };
  assert.equal(renderTemplateString('${job.id}-{{ media.path }}', ctx), 'j1-/in/a.wav');
  assert.equal(renderTemplateString('${media.meta}', ctx), '{"rate":16000}');
  assert.equal(renderTemplateString('[${empty}]', ctx), '[]');
  assert.throws(() => renderTemplateString('${job.nope}', ctx), /unknown template value: job.nope/);
  assert.deepEqual(renderConfigValue(['${job.id}', 3], ctx), ['j1', 3]);
  assert.equal(renderConfigValue('${job.id}', null), '${job.id}');
  assert.deepEqual(renderResultMap({ id: '${job.id}', n: 2, nested: { p: ['${media.path}'] } }, ctx), { id: 'j1', n: 2, nested: { p: ['/in/a.wav'] } });
  assert.deepEqual(renderResultMap(['x'], ctx), {});
});

test('helpers', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } }), { a: { b: 1, c: [2], d: 3 } });
  assert.equal(resolveConfigPath('/r', 'x/y'), '/r/x/y');
  for (const v of ['', '-', 'disabled', 'false', '/abs', 's3://b/k']) assert.equal(resolveConfigPath('/r', v), v);
});

test('resolveFunctionConfig merges defaults and overrides', () => {
  const config = {
    functions: { transcribe: { key: 'whisper', script: 'scripts/demo.sh' }, bare: {} },
    defaults: { whisper: { count: 2, tag: ['a'], color: 'auto' } },
    whisper: { color: 'never', tag: ['b'] },
  };
  const fn = resolveFunctionConfig('/srv', config, 'transcribe');
  assert.deepEqual(fn, {
    functionName: 'transcribe', key: 'whisper', script: '/srv/scripts/demo.sh',
    config: { count: 2, tag: ['b'], color: 'never' }, definition: config.functions.transcribe,
  });
  assert.equal(resolveFunctionConfig('/srv', config, 'missing'), null);
  assert.equal(resolveFunctionConfig('/srv', config, 'bare'), null);
  assert.throws(() => resolveFunctionConfig('/srv', { functions: { f: { key: 'k' } } }, 'f'), /function f does not define a script/);
});

test('buildFunctionCommand maps config through the schema', async () => {
  const root = workspace();
  const fn = resolveFunctionConfig(root, {
    functions: { f: { script: 'scripts/demo.sh' } },
    f: { out: 'results/${job.id}.txt', verbose: true, quiet: false, tag: ['${job.id}'], help: true, nope: 1 },
  }, 'f');
  warnings.length = 0;
  const context = { job: { id: 'j9' }, media: { path: '/drop/a.wav' } };
  const cmd = await buildFunctionCommand(fn, { configRoot: '/cfg', context, defaultPositional: '${media.path}' });
  assert.deepEqual(cmd, [fn.script, '/drop/a.wav', '--verbose', '--no-quiet', '--out', '/cfg/results/j9.txt', '--tag', 'j9']);
  assert.deepEqual(warnings, [
    '[%s] ignoring config key %s; it is controlled by %s demo.sh help test',
    '[%s] ignoring config key %s; no matching CLI option in schema demo.sh nope',
  ]);

  // Explicit positionals win; [] means none.
  fn.definition.positionals = ['${job.id}', ''];
  assert.deepEqual((await buildFunctionCommand(fn, { configRoot: '/cfg', context, controlled: [] })).slice(0, 2), [fn.script, 'j9']);
  fn.definition.positionals = [];
  assert.equal((await buildFunctionCommand(fn, { configRoot: '/cfg', context, defaultPositional: '${media.path}' })).includes('--'), false);
});

test('runScriptFunction runs the tool', async () => {
  const root = workspace();
  const fn = resolveFunctionConfig(root, { functions: { f: { script: 'scripts/demo.sh' } }, f: { input: 'in.txt', count: 5, mode: 'slow' } }, 'f');
  const result = await runScriptFunction(fn, { configRoot: root, env, cwd: root });
  assert.equal(result.exitCode, 0, result.stderr);
  const { values } = JSON.parse(result.stdout);
  assert.deepEqual([values.input, values.COUNT, values.mode], [join(root, 'in.txt'), 5, 'slow']);

  fn.config.count = 50;
  const bad = await runScriptFunction(fn, { configRoot: root, env, cwd: root });
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.stderrTail.length <= 40);
  assert.ok(bad.stderr.includes('--count must be <= 10, got 50'));
});

test('artifacts', () => {
  const root = workspace();
  const work = join(root, 'work');
  mkdirSync(join(work, 'sub/deep'), { recursive: true });
  for (const f of ['a.txt', 'b.json', 'sub/c.txt', 'sub/deep/d.txt']) writeFileSync(join(work, f), f);
  const context = { job: { id: 'j1' }, paths: { work_dir: work, artifacts_dir: join(root, 'done/j1.artifacts.d') } };
  assert.ok(globToRegex('/w/**/*.txt').test('/w/sub/deep/d.txt'));
  assert.ok(!globToRegex('/w/*.txt').test('/w/sub/c.txt'));
  assert.deepEqual(findFilesByArtifactPattern('**/*.txt', context), [join(work, 'a.txt'), join(work, 'sub/c.txt'), join(work, 'sub/deep/d.txt')]);
  assert.deepEqual(findFilesByArtifactPattern('b.json', context), [join(work, 'b.json')]);

  const fn = { definition: { artifacts: { include: ['*.txt', 'a.txt', '${job.id}.missing'], min: 1 } } };
  const copied = copyConfiguredArtifacts(fn, context, { keyPrefix: 'done/' });
  assert.deepEqual(copied, [{ source: join(work, 'a.txt'), key: 'done/j1.artifacts.d/a.txt' }]);
  assert.equal(readFileSync(join(root, 'done/j1.artifacts.d/a.txt'), 'utf8'), 'a.txt');
  assert.throws(() => copyConfiguredArtifacts(fn, context), /artifact directory already exists/);

  const ctx2 = { ...context, paths: { ...context.paths, artifacts_dir: join(root, 'out2') } };
  writeFileSync(join(work, 'sub/a.txt'), 'again');
  assert.throws(() => copyConfiguredArtifacts({ definition: { artifacts: '**/*.txt' } }, ctx2), /duplicate artifact filename/);
  const ctx3 = { ...context, paths: { ...context.paths, artifacts_dir: join(root, 'out3') } };
  assert.throws(() => copyConfiguredArtifacts({ definition: { artifacts: { include: '*.wav', required: true } } }, ctx3), /expected at least 1 artifact file\(s\) but matched 0/);
  assert.throws(() => copyConfiguredArtifacts({ definition: { artifacts: { required: 'yes' } } }, ctx3), /no include patterns/);
  assert.deepEqual(copyConfiguredArtifacts({ definition: {} }, ctx3), []);
  assert.equal(existsSync(join(root, 'out3')), false);
});

test('job records', () => {
  assert.match(newJobId('x'), /^job-[0-9a-f]{12}$/);
  assert.match(newJobId('x', 'wp1'), /^wp1-[0-9a-f]{12}$/);
  const r0 = newJobRecord({ jobId: 'j', functionName: 'f', fields: { client: 'c' }, now: 't0' });
  assert.deepEqual(r0, {
    job_id: 'j', client: 'c', function: 'f', status: 'pending', stage: null, started_at: 't0', updated_at: 't0',
    completed_at: null, error: null, result_key: null, history: [],
  });
  const r1 = transitionJobRecord(r0, { status: 'processing', stage: 'run', now: 't1' });
  const r2 = transitionJobRecord(r1, { status: 'done', resultKey: 'k', completedAt: 't2', now: 't2', extra: { agent: 'a' } });
  assert.deepEqual(r2.history, [{ status: 'processing', stage: 'run', updated_at: 't1' }, { status: 'pending', stage: null, updated_at: 't0' }]);
  assert.deepEqual([r2.status, r2.stage, r2.result_key, r2.completed_at, r2.agent], ['done', null, 'k', 't2', 'a']);
  assert.equal(r0.history.length, 0, 'records are not mutated');

  const fn = { functionName: 'f', key: 'k', script: '/s', config: { a: 1 }, definition: { result: { out: '${job.id}.txt' } } };
  assert.deepEqual(buildResultRecord({ jobId: 'j', fields: { c: 1 }, fn, artifactKeys: ['x'], context: { job: { id: 'j' } }, now: 't' }), {
    job_id: 'j', c: 1, function: 'f', function_key: 'k', script: '/s', artifact_keys: ['x'], completed_at: 't', config: { a: 1 }, out: 'j.txt',
  });
});

test('JobQueue runs with a concurrency limit and keeps records', async () => {
  const changes = [];
  const dropped = [];
  const queue = new JobQueue({ concurrency: 1, prefix: 'q', keep: 2, onChange: (r) => changes.push(`${r.job_id}:${r.status}`), onDrop: (r) => dropped.push(r.job_id) });
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = queue.add('a', async ({ stage }) => { order.push('a+'); stage('half'); await sleep(30); order.push('a-'); return 1; });
  const b = queue.add('b', async () => { order.push('b+'); throw new Error('boom'); }, { who: 'me' });
  const c = queue.add('c', async ({ signal }) => { await sleep(1000); signal.throwIfAborted(); return 3; });
  assert.match(a.record.job_id, /^q-/);
  assert.equal(b.record.status, 'pending');
  assert.equal(b.record.who, 'me');
  assert.equal(await a.done, 1);
  await assert.rejects(b.done, /boom/);
  assert.deepEqual(order, ['a+', 'a-', 'b+']);
  assert.deepEqual([a.record.status, a.result, b.record.status, b.record.error], ['done', 1, 'error', 'boom']);
  assert.ok(a.record.history.some((h) => h.stage === 'half'));
  c.cancel();
  await assert.rejects(c.done);
  assert.equal(c.record.error, 'cancelled');
  assert.equal(queue.get(a.record.job_id), undefined, 'only the newest 2 finished jobs are kept');
  assert.deepEqual(dropped, [a.record.job_id]);
  assert.deepEqual(queue.list().map((r) => r.function), ['b', 'c']);
  assert.ok(changes.includes(`${b.record.job_id}:error`));
});

test('runScriptFunction feeds stdin from a file, writes stdout to one and redacts secrets', async () => {
  const root = workspace();
  const cat = join(root, 'scripts/upper.sh');
  writeFileSync(cat, `#!/bin/sh\n# clyops-tool\nexec node -e '
const { Cli } = require(${JSON.stringify(join(repo, 'packages/js/dist/cjs/index.js'))});
const cli = new Cli({ name: "upper" });
cli.opt("TOKEN", "token", "", "optional", "Token", "Auth", "secret");
cli.setStdin("Text", "text/plain"); cli.setStdout("Upper case", "text/plain");
cli.run(process.argv.slice(1));
process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()));
' -- "$@"\n`);
  chmodSync(cat, 0o755);
  writeFileSync(join(root, 'in.txt'), 'hello');
  const config = {
    functions: { up: { script: 'scripts/upper.sh', stdin: '${paths.in}', stdout: 'out/${job.id}.txt', artifacts: { required: true } } },
    up: { token: 's3cret' },
  };
  const fn = resolveFunctionConfig(root, config, 'up');
  const context = { job: { id: 'j1' }, paths: { in: 'in.txt', work_dir: join(root, 'work'), artifacts_dir: join(root, 'done') } };
  const result = await runScriptFunction(fn, { configRoot: root, context, env, cwd: root });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'work/out/j1.txt'), 'utf8'), 'HELLO');
  assert.equal(result.stdout, '');
  assert.ok(result.command.includes('***') && !result.command.includes('s3cret'));
  assert.deepEqual(copyConfiguredArtifacts(fn, context).map((a) => a.key), ['done/j1.txt']);
});

test('function positional order is configurable and supports legacy wrappers', async () => {
  const root = workspace();
  const script = join(root, 'scripts/legacy.sh');
  const schema = { clyops: 1, description: '', arguments: [{ name: 'input', default: '', validation: '' }], options: [{ name: 'count', variableName: 'COUNT', choices: [], isFlag: false, validation: '' }] };
  writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$1"\n');
  chmodSync(script, 0o755);
  const fn = { functionName: 'legacy', key: 'legacy', script, config: { input: 'clip.wav', count: 2 }, definition: {} };
  const opts = { configRoot: root };
  const first = await buildFunctionCommand(fn, opts, schema);
  assert.deepEqual(first.slice(1), ['clip.wav', '--count', '2']);
  const { run } = await import('../../tools/dist/index.js');
  assert.equal((await run(script, first.slice(1))).stdout.trim(), 'clip.wav');
  fn.definition.positionals_order = 'last';
  assert.deepEqual((await buildFunctionCommand(fn, opts, schema)).slice(1), ['--count', '2', 'clip.wav']);
  fn.config.input = '-clip.wav';
  assert.deepEqual((await buildFunctionCommand(fn, opts, schema)).slice(1), ['--count', '2', '--', '-clip.wav']);
  fn.definition.positionals_order = 'sideways';
  await assert.rejects(buildFunctionCommand(fn, opts, schema), /order must be first or last/);
});
