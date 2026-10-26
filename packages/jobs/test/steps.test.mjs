import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFunctionCommand, buildResultRecord, copyConfiguredArtifacts, functionParamNames, resolveFunctionConfig, runScriptFunction } from '../dist/index.js';

const env = { PATH: process.env.PATH };
const skip = process.platform === 'win32';

// A tool that answers --help-json-schema with `schema` and otherwise runs `body`.
function tool(root, name, schema, body) {
  const file = join(root, 'scripts', name);
  const doc = JSON.stringify({ clyops: 1, description: '', arguments: [], options: [], ...schema });
  writeFileSync(file, `#!/bin/bash\nif [ "$1" = --help-json-schema ]; then echo '${doc}'; exit 0; fi\n${body}\n`);
  chmodSync(file, 0o755);
}

const option = (name) => ({ name, variableName: name.toUpperCase(), choices: [], isFlag: false, validation: '' });

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-steps-')));
  mkdirSync(join(root, 'scripts'));
  // fetch --id X: JSON naming where the media is.
  tool(root, 'fetch.sh', { options: [option('id')] }, 'echo "{\\"signedUrl\\": \\"media-$2.txt\\", \\"size\\": 3}"');
  // download --url U: the file's text on stdout.
  tool(root, 'download.sh', { options: [option('url')] }, 'printf "got %s" "$2"');
  // upper: stdin upper-cased, with progress and result roles.
  const role = (name) => ({ name, direction: 'out', description: '', contentType: 'application/json', schema: null });
  tool(root, 'upper.sh', { roles: [role('progress'), role('result')] }, [
    'for e in ${CLYOPS_FDS//,/ }; do declare "fd_${e%%:*}=${e#*:}"; done',
    'tr a-z A-Z',
    '[ -n "$fd_progress" ] && echo \'{"pct": 50}\' >&"$fd_progress"',
    '[ -n "$fd_result" ] && echo \'{"ok": true}\' >&"$fd_result"',
    'exit 0',
  ].join('\n'));
  // fail --code N: exits N after a line on stdout.
  tool(root, 'fail.sh', { options: [option('code')] }, 'echo partial; exit "$2"');
  return root;
}

const fingerprint = {
  functions: {
    fp: {
      steps: [
        { name: 'fetch', script: 'scripts/fetch.sh' },
        { name: 'download', script: 'scripts/download.sh', stdout: '${job.id}/media.txt' },
        { name: 'upper', script: 'scripts/upper.sh', stdin: '${steps.download.stdout}', stdout: '${job.id}/fp.txt' },
      ],
      artifacts: { include: ['${job.id}/fp.txt'], required: true },
      result: { size: '${steps.fetch.result.size}', ok: '${steps.upper.result.ok}' },
    },
  },
  fetch: { id: '${params.id}' },
  download: { url: '${steps.fetch.result.signedUrl}' },
};

test('resolveFunctionConfig resolves steps', () => {
  const fn = resolveFunctionConfig('/srv', { ...fingerprint, defaults: { fetch: { id: 'x' } } }, 'fp');
  assert.deepEqual(fn.steps.map((s) => [s.stepName, s.key, s.script]), [
    ['fetch', 'fetch', '/srv/scripts/fetch.sh'], ['download', 'download', '/srv/scripts/download.sh'], ['upper', 'upper', '/srv/scripts/upper.sh'],
  ]);
  assert.equal(fn.script, '/srv/scripts/upper.sh');
  assert.deepEqual(fn.config, { fetch: { id: '${params.id}' }, download: { url: '${steps.fetch.result.signedUrl}' }, upper: {} });
  assert.deepEqual(functionParamNames(fn), ['id']);
  const bad = (f) => () => resolveFunctionConfig('/srv', { functions: { f } }, 'f');
  assert.throws(bad({ script: 'a', steps: [{ name: 'a', script: 'a' }] }), /function f defines both script and steps/);
  assert.throws(bad({ steps: [] }), /function f defines no steps/);
  assert.throws(bad({ steps: [{ name: 'a b', script: 'a' }] }), /function f step 1 needs a name/);
  assert.throws(bad({ steps: [{ name: 'a', script: 'a' }, { name: 'a', script: 'b' }] }), /function f has two steps named a/);
  assert.throws(bad({ steps: [{ name: 'a' }] }), /function f step a does not define a script/);
  // strict_params carries into steps unless a step sets its own.
  const strict = resolveFunctionConfig('/srv', { functions: { f: { strict_params: true, steps: [{ name: 'a', script: 'a' }, { name: 'b', script: 'b', strict_params: false }] } } }, 'f');
  assert.deepEqual(strict.steps.map((s) => s.definition.strict_params), [true, false]);
});

test('a chain feeds each step the earlier ones\' outputs', { skip }, async () => {
  const root = workspace();
  const fn = resolveFunctionConfig(root, fingerprint, 'fp');
  await assert.rejects(buildFunctionCommand(fn, { configRoot: root }), /function fp runs steps/);
  const context = { job: { id: 'j1' }, params: { id: '42' }, paths: { work_dir: join(root, 'work'), artifacts_dir: join(root, 'done/j1') } };
  const updates = [];
  const run = await runScriptFunction(fn, { configRoot: root, context, env, cwd: root, onProgress: (u) => updates.push(u) });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(run.failedStep, undefined);
  assert.deepEqual(run.stepRuns.map((r) => [r.step, r.command.slice(1)]), [['fetch', ['--id', '42']], ['download', ['--url', 'media-42.txt']], ['upper', []]]);
  assert.deepEqual(run.steps.fetch, { exit_code: 0, stdout: '{"signedUrl": "media-42.txt", "size": 3}', result: { signedUrl: 'media-42.txt', size: 3 } });
  assert.equal(run.steps.download.stdout, join(root, 'work/j1/media.txt'));
  assert.deepEqual(run.result, { ok: true });
  assert.deepEqual(updates, [{ stage: 'upper', pct: 50, step: 'upper' }]);
  assert.equal(readFileSync(join(root, 'work/j1/fp.txt'), 'utf8'), 'GOT MEDIA-42.TXT');

  const full = { ...context, steps: run.steps };
  assert.deepEqual(copyConfiguredArtifacts(fn, full).map((a) => a.key), ['j1/fp.txt']);
  const record = buildResultRecord({ jobId: 'j1', fn, artifactKeys: [], context: full, now: 't' });
  assert.deepEqual([record.size, record.ok, record.script], ['3', 'true', join(root, 'scripts/upper.sh')]);
});

test('the first failing step stops the chain and is named', { skip }, async () => {
  const root = workspace();
  const config = (code, more = {}) => ({
    functions: { f: { steps: [{ name: 'first', script: 'scripts/fail.sh', ...more }, { name: 'second', script: 'scripts/fetch.sh' }] } },
    first: { code }, second: { id: '${steps.first.stdout}' },
  });
  const run = async (cfg) => runScriptFunction(resolveFunctionConfig(root, cfg, 'f'), { configRoot: root, context: {}, env, cwd: root });

  const failed = await run(config(3));
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.failedStep, 'first');
  assert.deepEqual(failed.stepRuns.map((r) => r.step), ['first']);

  // An exit code the step allows goes on, and the chain reports it.
  const partial = await run(config(2, { continue_on_exit: [2] }));
  assert.equal(partial.failedStep, undefined);
  assert.equal(partial.exitCode, 2);
  assert.deepEqual(partial.steps.second.result, { signedUrl: 'media-partial.txt', size: 3 });

  // A missing step value is a config error naming the step.
  const typo = config(0);
  typo.second.id = '${steps.frist.stdout}';
  await assert.rejects(run(typo), /step second: unknown template value: steps.frist.stdout/);
  const missing = config(0);
  missing.second.id = '${steps.first.result.x}';
  await assert.rejects(run(missing), /step second: unknown template value: steps.first.result.x/);
});

test('step and chain time limits', { skip, timeout: 10_000 }, async () => {
  const root = workspace();
  tool(root, 'slow.sh', {}, 'sleep 5');
  const steps = (more = {}) => ({ functions: { f: { steps: [{ name: 'quick', script: 'scripts/fetch.sh' }, { name: 'slow', script: 'scripts/slow.sh', ...more }] } } });
  const run = (cfg, timeoutMs) => runScriptFunction(resolveFunctionConfig(root, cfg, 'f'), { configRoot: root, env, cwd: root, timeoutMs });
  for (const [cfg, timeoutMs] of [[steps({ timeout_ms: 200 }), undefined], [steps(), 300]]) {
    const result = await run(cfg, timeoutMs);
    assert.equal(result.timedOut, true);
    assert.equal(result.failedStep, 'slow');
    assert.ok(result.durationMs < 2000, String(result.durationMs));
  }
  // Cancelling stops the running step.
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  const cancelled = await runScriptFunction(resolveFunctionConfig(root, steps(), 'f'), { configRoot: root, env, cwd: root, signal: abort.signal });
  assert.equal(cancelled.failedStep, 'slow');
  assert.ok(cancelled.signal);
});
