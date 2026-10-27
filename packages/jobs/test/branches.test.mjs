// Branching in multi-step functions, against an `outcome` tool that does what
// its options say: exit with a code, print a result, sleep or kill itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pbkdf2 } from 'node:crypto';
import { join } from 'node:path';
import { buildResultRecord, resolveFunctionConfig, runContext, runScriptFunction } from '../dist/index.js';

const env = { PATH: process.env.PATH };
const skip = process.platform === 'win32';

const option = (name, isFlag = false) => ({ name, variableName: name.toUpperCase(), choices: [], isFlag, validation: '' });
const SCHEMA = JSON.stringify({ clyops: 1, description: '', arguments: [], options: [option('exit'), option('say'), option('sleep'), option('kill', true), option('trap', true)] });

// outcome [--say TEXT] [--sleep S] [--kill] [--trap] [--exit N]: prints TEXT, sleeps, then exits N or kills
// itself; with --trap, SIGTERM (a timeout) makes it exit 0.
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-branches-')));
  mkdirSync(join(root, 'scripts'));
  const file = join(root, 'scripts/outcome.sh');
  writeFileSync(file, `#!/bin/bash
if [ "$1" = --help-json-schema ]; then echo '${SCHEMA}'; exit 0; fi
code=0 say= nap=0 die=
while [ $# -gt 0 ]; do
  case $1 in
    --exit) code=$2; shift 2 ;;
    --say) say=$2; shift 2 ;;
    --sleep) nap=$2; shift 2 ;;
    --kill) die=1; shift ;;
    --trap) trap 'exit 0' TERM; shift ;;
    *) shift ;;
  esac
done
[ -n "$say" ] && printf '%s\\n' "$say"
[ "$nap" != 0 ] && { sleep "$nap" & wait $!; }
[ -n "$die" ] && kill -9 $$
exit "$code"
`);
  chmodSync(file, 0o755);
  return root;
}

// A function from steps given as { name, options, ...binding }; each step's options are its block.
function chain(steps, fn = {}) {
  const config = { functions: { f: { ...fn, steps: steps.map(({ options, ...step }) => ({ script: 'scripts/outcome.sh', ...step })) } } };
  for (const { name, options } of steps) config[name] = options ?? {};
  return config;
}

const names = (run) => run.stepRuns.map((r) => r.step);
const runChain = (root, config, opts = {}) =>
  runScriptFunction(resolveFunctionConfig(root, config, 'f'), { configRoot: root, cwd: root, env, context: { job: { id: 'j' } }, ...opts });

// The rules, as a reference: what a chain of outcomes should do.
//   step.outcome: { code } runs and exits code; { error: true } can't start.
function expected(steps) {
  const at = (target) => steps.findIndex((s) => s.name === target);
  const ran = [];
  const seen = [];
  let continued;
  for (let i = 0; ;) {
    const step = steps[i];
    if (step.outcome.error) {
      if (!step.error) return { rejects: `step ${step.name}:`, ran };
      seen.push(step.name);
      i = at(step.error);
      continue;
    }
    ran.push(step.name);
    seen.push(step.name);
    const { code } = step.outcome;
    if (code === 0 || (step.continue_on_exit ?? []).includes(code)) {
      if (code !== 0) continued ??= code;
      const next = step.succeed === '$end' ? -1 : step.succeed ? at(step.succeed) : i + 1 < steps.length ? i + 1 : -1;
      if (next < 0) return { ran, seen, exitCode: code || continued || 0 };
      i = next;
    } else {
      if (!step.fail) return { ran, seen, exitCode: code, failedStep: step.name };
      i = at(step.fail);
    }
  }
}

// A small seeded generator, so a failing case can be replayed with CLYOPS_STEPS_SEED.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChain(rand) {
  const pick = (items) => items[Math.floor(rand() * items.length)];
  const count = 1 + Math.floor(rand() * 6);
  const steps = [];
  for (let i = 0; i < count; i += 1) {
    const later = Array.from({ length: count - i - 1 }, (_, k) => `s${i + k + 1}`);
    const outcome = pick([{ code: 0 }, { code: 0 }, { code: 1 }, { code: 2 }, { code: 2 }, { code: 3 }, { error: true }]);
    const step = { name: `s${i}`, outcome };
    if (rand() < 0.6) step.continue_on_exit = [2];
    if (later.length && rand() < 0.4) step.fail = pick(later);
    if (later.length && rand() < 0.3) step.error = pick(later);
    if (rand() < 0.4) step.succeed = pick([...later, '$end']);
    steps.push(step);
  }
  return steps;
}

// Each step writes the outputs it saw (`${steps}`) and the step before it (`${previous}`, which the
// first step has none of) to DIR/NAME.json, so the run shows what every template could reach. A
// stdout file keeps the outputs small: a step's `stdout` is then the path, and it has no `result`.
function toConfig(steps, dir) {
  return chain(steps.map(({ outcome, ...step }, i) => ({
    ...step,
    stdout: `${dir}/${step.name}.json`,
    options: outcome.error ? { exit: '${steps.missing.x}' } : { exit: outcome.code, say: `{"saw": \${steps}, "previous": ${i ? '${previous}' : 'null'}}` },
  })));
}

test('random chains follow the branching rules', { skip, timeout: 120_000 }, async () => {
  const root = workspace();
  const seed = Number(process.env.CLYOPS_STEPS_SEED ?? 46);
  const rand = random(seed);
  const cases = Number(process.env.CLYOPS_STEPS_CASES ?? 300);
  const shapes = { rejects: 0, failed: 0, partial: 0, ok: 0, branched: 0 };
  for (let n = 0; n < cases; n += 1) {
    const steps = randomChain(rand);
    const want = expected(steps);
    const label = `seed ${seed} case ${n}: ${JSON.stringify(steps)}`;
    if (want.rejects) {
      shapes.rejects += 1;
      await assert.rejects(runChain(root, toConfig(steps, `case${n}`)), (e) => e.message.startsWith(want.rejects), label);
      continue;
    }
    const run = await runChain(root, toConfig(steps, `case${n}`));
    assert.deepEqual(names(run), want.ran, label);
    assert.equal(run.exitCode, want.exitCode, label);
    assert.equal(run.failedStep, want.failedStep, label);
    assert.deepEqual(Object.keys(run.steps), want.seen, label);
    // Every step saw exactly the steps before it on the path, nothing skipped or later.
    for (const [i, r] of run.stepRuns.entries()) {
      const before = want.seen.slice(0, want.seen.indexOf(r.step));
      const seen = JSON.parse(readFileSync(run.steps[r.step].stdout, 'utf8'));
      assert.deepEqual(Object.keys(seen.saw), before, `${label} step ${r.step} (${i})`);
      const previous = before.at(-1);
      assert.deepEqual(seen.previous, previous ? { name: previous, ...run.steps[previous] } : null, `${label} previous of ${r.step}`);
    }
    const final = want.seen.at(-1);
    assert.deepEqual(run.previous, { name: final, ...run.steps[final] }, label);
    for (const name of want.seen) if (steps.find((s) => s.name === name).outcome.error) assert.equal(run.steps[name].exit_code, null, label);
    shapes[want.failedStep ? 'failed' : want.exitCode ? 'partial' : 'ok'] += 1;
    if (want.ran.length !== steps.length || want.seen.length !== want.ran.length) shapes.branched += 1;
  }
  // The generator reaches every kind of ending, so the rules above were all exercised.
  for (const [shape, count] of Object.entries(shapes)) assert.ok(count >= 10, `only ${count} ${shape} cases: ${JSON.stringify(shapes)}`);
});

test('a step timing out takes its fail branch; the chain running out of time does not', { skip, timeout: 10_000 }, async () => {
  const root = workspace();
  const steps = (more) => [
    { name: 'slow', options: { sleep: 5 }, fail: 'after', ...more },
    { name: 'skipped' },
    { name: 'after', options: { say: '${steps.slow.exit_code}' } },
  ];
  const own = await runChain(root, chain(steps({ timeout_ms: 200 })));
  assert.deepEqual([names(own), own.exitCode, own.failedStep], [['slow', 'after'], 0, undefined]);
  assert.equal(own.stepRuns[0].timedOut, true);
  // A timed-out step fails, even when it exits 0 on SIGTERM or with a code it lists.
  for (const more of [{ trap: true }, { trap: true, exit: 2 }]) {
    const graceful = await runChain(root, chain(steps({ timeout_ms: 200, continue_on_exit: [2], options: { sleep: 5, ...more } })));
    assert.deepEqual([names(graceful), graceful.stepRuns[0].exitCode, graceful.stepRuns[0].timedOut], [['slow', 'after'], 0, true], JSON.stringify(more));
  }
  const noBranch = await runChain(root, chain([{ name: 'slow', options: { sleep: 5, trap: true }, timeout_ms: 200 }, { name: 'next' }]));
  assert.deepEqual([names(noBranch), noBranch.failedStep, noBranch.exitCode], [['slow'], 'slow', 0]);

  const chainLimit = await runChain(root, chain(steps({})), { timeoutMs: 300 });
  assert.deepEqual([names(chainLimit), chainLimit.failedStep, chainLimit.timedOut], [['slow'], 'slow', true]);
});

test('a step killed by a signal takes its fail branch; a cancelled chain does not', { skip, timeout: 10_000 }, async () => {
  const root = workspace();
  const steps = [{ name: 'dies', options: { kill: true }, fail: 'after' }, { name: 'after', options: { say: '[${steps.dies.exit_code}]' } }];
  const killed = await runChain(root, chain(steps));
  assert.deepEqual(names(killed), ['dies', 'after']);
  assert.equal(killed.stepRuns[0].signal, 'SIGKILL');
  assert.equal(killed.stdout, '[]\n');

  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  const cancelled = await runChain(root, chain([{ ...steps[0], options: { sleep: 5 } }, steps[1]]), { signal: abort.signal });
  assert.deepEqual([names(cancelled), cancelled.failedStep], [['dies'], 'dies']);
  assert.ok(cancelled.signal);
  // Cancelled before a step starts, the step is stopped at once.
  const early = await runChain(root, chain(steps), { signal: AbortSignal.abort() });
  assert.deepEqual(names(early), ['dies']);
});

test('handlers chain, fall through and end', { skip }, async () => {
  const root = workspace();
  // try fails → first fails → second recovers; second has no succeed, so it falls through to tail.
  const handlers = await runChain(root, chain([
    { name: 'try', options: { exit: 1 }, fail: 'first', succeed: 'tail' },
    { name: 'first', options: { exit: 5 }, fail: 'second' },
    { name: 'second', options: { say: '${steps.first.exit_code}' } },
    { name: 'tail', options: { say: 'tail' } },
  ]));
  assert.deepEqual([names(handlers), handlers.exitCode, handlers.failedStep], [['try', 'first', 'second', 'tail'], 0, undefined]);
  assert.equal(handlers.stepRuns[2].stdout, '5\n');

  // A partial exit takes the succeed branch, and the chain reports it even after later successes.
  const partial = await runChain(root, chain([
    { name: 'a', options: { exit: 2 }, continue_on_exit: [2], succeed: 'c', fail: 'b' },
    { name: 'b', options: { exit: 1 } },
    { name: 'c', options: { exit: 7 }, continue_on_exit: [7] },
    { name: 'd' },
  ]));
  assert.deepEqual([names(partial), partial.exitCode], [['a', 'c', 'd'], 2]);

  // succeed: $end stops at once, even with steps left.
  const ended = await runChain(root, chain([{ name: 'a', succeed: '$end' }, { name: 'b', options: { exit: 1 } }]));
  assert.deepEqual([names(ended), ended.exitCode], [['a'], 0]);
});

test('a skipped step is not in the outputs, and naming it is an error', { skip }, async () => {
  const root = workspace();
  const config = chain([
    { name: 'a', succeed: 'c' },
    { name: 'b', options: { say: 'b' } },
    { name: 'c', options: { say: '${steps.b.stdout}' }, error: 'd' },
    { name: 'd', options: { say: '${steps.c.error}' } },
  ]);
  const run = await runChain(root, config);
  assert.deepEqual(names(run), ['a', 'd']);
  assert.deepEqual(Object.keys(run.steps), ['a', 'c', 'd']);
  assert.equal(run.stdout, 'step c: unknown template value: steps.b.stdout\n');
  delete config.functions.f.steps[2].error;
  await assert.rejects(runChain(root, config), (e) => e.message === 'step c: unknown template value: steps.b.stdout');
});

test('error branches cover every way a step can fail to start', { skip }, async () => {
  const root = workspace();
  const tail = { name: 'tail', options: { say: '${steps.first.error}' } };
  const cases = [
    [{ stdin: 'missing.txt' }, /ENOENT/],
    [{ script: 'scripts/nope.sh' }, /nope\.sh/],
    [{ options: { exit: '${params.x}' }, strict_params: true }, /unknown template value: params.x/],
  ];
  for (const [more, message] of cases) {
    const run = await runChain(root, chain([{ name: 'first', error: 'tail', ...more }, tail]));
    assert.deepEqual(names(run), ['tail'], String(message));
    assert.match(run.steps.first.error, message);
    assert.match(run.stdout, /^step first: /);
    assert.equal(run.exitCode, 0);
  }
  // A missing params field stays unset, not an error, unless strict.
  const unset = await runChain(root, chain([{ name: 'first', options: { exit: '${params.x}' }, error: 'tail' }, { name: 'tail' }]), { context: { params: {} } });
  assert.deepEqual([names(unset), unset.stepRuns[0].command.slice(1)], [['first', 'tail'], []]);
});

test('a missing stdin file fails the step even when the tool exits without reading it', { skip }, async () => {
  // The tool exits at once; the error must not depend on which finishes first. Busy libuv
  // threads delay any lazy open past the tool's exit, as a slow runner did on macOS.
  const root = workspace();
  const busy = () => Promise.all(Array.from({ length: 8 }, () => new Promise((done) => pbkdf2('x', 'y', 300_000, 32, 'sha256', done))));
  const crowded = busy();
  await assert.rejects(runScriptFunction(resolveFunctionConfig(root, { functions: { f: { script: 'scripts/outcome.sh', stdin: 'missing.txt' } } }, 'f'), { configRoot: root, cwd: root, env }), { code: 'ENOENT' }, 'with busy threads');
  await crowded;
  const config = chain([{ name: 'first', stdin: 'missing.txt', error: 'tail' }, { name: 'tail' }]);
  for (let n = 0; n < 25; n += 1) {
    const run = await runChain(root, config);
    assert.deepEqual(names(run), ['tail'], `attempt ${n}`);
    assert.match(run.steps.first.error, /ENOENT.*missing\.txt/);
  }
  const fn = resolveFunctionConfig(root, { functions: { f: { script: 'scripts/outcome.sh', stdin: 'missing.txt' } } }, 'f');
  for (let n = 0; n < 25; n += 1) await assert.rejects(runScriptFunction(fn, { configRoot: root, cwd: root, env }), { code: 'ENOENT' }, `attempt ${n}`);
});

test('step templates render without a caller context', { skip }, async () => {
  const root = workspace();
  const config = chain([{ name: 'a', options: { say: 'hi' } }, { name: 'b', options: { say: '${steps.a.stdout}!' } }]);
  for (const context of [undefined, null]) {
    const run = await runChain(root, config, { context });
    assert.equal(run.stdout, 'hi!\n', String(context));
  }
});

test('progress, durations and the run belong to the right steps', { skip }, async () => {
  const root = workspace();
  const run = await runChain(root, chain([{ name: 'a', options: { say: '{"n": 1}' } }, { name: 'b', options: { say: '{"n": 2}', exit: 2 }, continue_on_exit: [2] }]));
  assert.deepEqual(run.result, { n: 2 });
  assert.deepEqual([run.steps.a.result, run.steps.b.exit_code], [{ n: 1 }, 2]);
  assert.equal(run.durationMs, run.stepRuns[0].durationMs + run.stepRuns[1].durationMs);
  assert.deepEqual(run.command.slice(1), ['--exit', '2', '--say', '{"n": 2}']);
});

test('previous is the step before, whichever branch led here', { skip }, async () => {
  const root = workspace();
  // Two steps share one handler, which reports which of them failed and what it said.
  const config = (failing) => chain([
    { name: 'fetch', options: { say: '{"from": "fetch"}', exit: failing === 'fetch' ? 1 : 0 }, fail: 'report' },
    { name: 'mirror', options: { say: '{"from": "mirror"}', exit: failing === 'mirror' ? 3 : 0 }, fail: 'report', succeed: '$end' },
    { name: 'report', options: { say: '${previous.name} ${previous.exit_code} ${previous.result.from}' } },
  ], { result: { reported: '${previous.stdout}', by: '${previous.name}' } });
  for (const [failing, said] of [['fetch', 'fetch 1 fetch'], ['mirror', 'mirror 3 mirror']]) {
    const fn = resolveFunctionConfig(root, config(failing), 'f');
    const run = await runScriptFunction(fn, { configRoot: root, cwd: root, env, context: {} });
    assert.equal(run.stdout, `${said}\n`, failing);
    assert.deepEqual(run.previous, { name: 'report', ...run.steps.report });
    const record = buildResultRecord({ jobId: 'j', fn, artifactKeys: [], context: runContext({}, run), now: 't' });
    assert.deepEqual([record.reported, record.by], [said, 'report']);
  }
  const ok = await runChain(root, config(null));
  assert.deepEqual([names(ok), ok.previous.name], [['fetch', 'mirror'], 'mirror']);

  // After an error branch, previous is the step that couldn't start.
  const errored = await runChain(root, chain([
    { name: 'broken', options: { exit: '${steps.nope.x}' }, error: 'report' },
    { name: 'report', options: { say: '${previous.name}: ${previous.error}' } },
  ]));
  assert.equal(errored.stdout, 'broken: step broken: unknown template value: steps.nope.x\n');

  // The first step has no previous; naming it is an error.
  await assert.rejects(runChain(root, chain([{ name: 'first', options: { say: '${previous.name}' } }])), (e) => e.message === 'step first: unknown template value: previous.name');
  // runContext leaves a single-tool run's context alone.
  assert.deepEqual(runContext({ job: 1 }, { exitCode: 0 }), { job: 1 });
});
