import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, commands, discover, inputKeys, loadSchema, run, tail, toArgv, toJsonSchema } from '../dist/index.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const golden = JSON.parse(readFileSync(join(repo, 'spec/conformance/golden/schema.json'), 'utf8'));

function file(path, text, exec = true) {
  writeFileSync(path, text);
  if (exec) chmodSync(path, 0o755);
}

// A tools tree around the JavaScript conformance demo.
function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-tools-')));
  const demo = `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/demo.cjs')} "$@"\n`;
  mkdirSync(join(root, 'media/fp'), { recursive: true });
  mkdirSync(join(root, 'empty'));
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(root, 'more'));
  file(join(root, '.clyops'), 'description: Test tools\nignore: lib, skipped\n', false);
  file(join(root, 'media/.clyops'), 'description: Media tools\n', false);
  file(join(root, 'demo.sh'), demo);
  file(join(root, 'hello'), '#!/bin/sh\necho hello\n');
  file(join(root, 'skipped.sh'), demo);
  file(join(root, 'notes.txt'), 'not executable\n', false);
  file(join(root, '.hidden'), demo);
  file(join(root, 'media.sh'), demo); // shadowed by the media group
  file(join(root, 'media/to-pcm.py'), demo);
  file(join(root, 'media/fp/index'), demo);
  file(join(root, 'lib/helper.sh'), demo);
  file(join(root, 'more/extra'), demo);
  // A nested dispatcher whose tools live in ./more, and one pointing back up.
  file(join(root, 'nested'), '#!/usr/bin/env clyops-dispatch\ndescription: Nested tools\ndir: more\n');
  file(join(root, 'more/loop'), '#!/usr/bin/env clyops-dispatch\ndir: ..\n');
  return root;
}

test('discover follows the dispatcher rules', () => {
  const root = tree();
  const t = discover(root, { name: 'tools' });
  assert.equal(t.name, 'tools');
  assert.equal(t.description, 'Test tools');
  assert.deepEqual(t.commands.map((c) => c.name), ['demo', 'hello']);
  assert.deepEqual(t.groups.map((g) => g.name), ['media', 'more', 'nested']);
  const media = t.groups[0];
  assert.equal(media.description, 'Media tools');
  assert.deepEqual(media.commands.map((c) => [c.name, c.words, c.kind]), [['to-pcm', ['media', 'to-pcm'], 'tool']]);
  assert.deepEqual(media.groups[0].commands[0].words, ['media', 'fp', 'index']);
  assert.equal(t.commands.find((c) => c.name === 'hello').kind, 'other');
  const nested = t.groups[2];
  assert.equal(nested.description, 'Nested tools');
  assert.deepEqual(nested.commands.map((c) => c.name), ['extra', 'loop']);
  assert.equal(nested.commands[1].kind, 'dispatcher', 'a definition pointing back up is not followed again');
  assert.ok(commands(t).some((c) => c.words.join(' ') === 'media fp index'));
});

test('discover from a definition file', () => {
  const root = tree();
  file(join(root, 'tools'), '#!/usr/bin/env clyops-dispatch\ndescription: From a definition\nignore: lib, more, nested\n');
  const link = join(mkdtempSync(join(tmpdir(), 'clyops-bin-')), 'mytool');
  symlinkSync(join(root, 'tools'), link);
  const t = discover(link);
  assert.equal(t.name, 'mytool');
  assert.equal(t.description, 'From a definition');
  assert.deepEqual(t.commands.map((c) => c.name), ['demo', 'hello', 'skipped']);
  assert.deepEqual(t.groups.map((g) => g.name), ['media']);
});

test('settings errors name the line', () => {
  const root = tree();
  file(join(root, 'media/.clyops'), 'description: ok\ncolour: red\n', false);
  assert.throws(() => discover(root), /media\/\.clyops:2: unknown key 'colour'/);
});

test('classify', () => {
  const root = tree();
  assert.equal(classify(join(root, 'demo.sh')), 'tool');
  assert.equal(classify(join(root, 'hello')), 'other');
  assert.equal(classify(join(root, 'nested')), 'dispatcher');
  assert.equal(classify(join(root, 'missing')), 'other');
});

test('loadSchema reads and caches --help-json-schema', async () => {
  const root = tree();
  const schema = await loadSchema(join(root, 'demo.sh'));
  assert.deepEqual(schema, golden);
  assert.equal(loadSchema(join(root, 'demo.sh')), loadSchema(join(root, 'demo.sh')));
  await assert.rejects(loadSchema(join(root, 'hello')), /produced no JSON schema/);
});

test('inputKeys', () => {
  const noCache = golden.options.find((o) => o.name === 'no-cache');
  assert.deepEqual(inputKeys(noCache), ['no_cache', 'no-cache']);
  const dataDir = golden.options.find((o) => o.name === 'data-dir');
  assert.deepEqual(inputKeys(dataDir), ['data_dir', 'data-dir']);
  assert.deepEqual(inputKeys(golden.arguments[0]), ['input']);
});

test('toArgv maps every kind of option', () => {
  const { argv, unknown, controlled } = toArgv(golden, {
    input: '-in.txt', mode: 'slow', rest: ['a', 'b'],
    verbose: true, quiet: 'no', color: 'never', count: 7, ratio: 0.25, enabled: false,
    tag: ['x', 'y'], 'no-cache': true, port: 9000, notes: null, silent: true, help: true, bogus: 1,
  }, { controlled: ['help'] });
  assert.deepEqual(argv, [
    '--verbose', '--no-quiet', '--color', 'never', '--count', '7', '--ratio', '0.25', '--enabled', 'false',
    '--tag', 'x', '--tag', 'y', '--no-cache', '--port', '9000', '--', '-in.txt', 'slow', 'a', 'b',
  ]);
  assert.deepEqual(unknown, ['silent', 'bogus']);
  assert.deepEqual(controlled, ['help']);
});

test('toArgv fills skipped positionals with defaults, resolves paths and renders', () => {
  const base = '/base';
  const render = (s) => s.replace('${name}', 'world');
  assert.deepEqual(
    toArgv(golden, { input: 'in-${name}.txt', rest: ['r'], out: 'o.txt', config: '-', include: ['a', '/abs', 'http://x/y'] }, { base, render }).argv,
    ['--config', '-', '--out', '/base/o.txt', '--include', '/base/a', '--include', '/abs', '--include', 'http://x/y', '--', '/base/in-world.txt', 'fast', 'r'],
  );
  assert.throws(() => toArgv(golden, { mode: 'slow' }), /mode is given, so input must be too/);
  assert.deepEqual(toArgv(golden, { input: 'ignored', verbose: true }, { positionals: ['p1'] }).argv, ['--verbose', '--', 'p1']);
});

test('toArgv output is what the tool resolves', async () => {
  const root = tree();
  const input = { input: 'in.txt', mode: 'slow', rest: ['a', '-b'], verbose: true, enabled: false, tag: ['x', 'y'], count: 4, include: ['i1'], email: 'a@b.co' };
  const result = await run(join(root, 'demo.sh'), toArgv(golden, input).argv, { cwd: root, env: { PATH: process.env.PATH, DEMO_ROOT: root, KEY: 'k' } });
  assert.equal(result.exitCode, 0, result.stderr);
  const { values } = JSON.parse(result.stdout);
  assert.deepEqual(
    [values.input, values.mode, values.rest, values.VERBOSE, values.ENABLED, values.TAG, values.COUNT, values.INCLUDE, values.EMAIL],
    [join(root, 'in.txt'), 'slow', ['a', '-b'], true, false, ['x', 'y'], 4, [join(root, 'i1')], 'a@b.co'],
  );
});

test('run reports failures, timeouts and aborts', async () => {
  const root = tree();
  const bad = await run(join(root, 'demo.sh'), ['--count', '99', 'in.txt'], { env: { PATH: process.env.PATH, KEY: 'k' } });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /--count must be <= 10, got 99/);
  assert.deepEqual(tail('\x1b[31mone\x1b[0m\n\ntwo\nthree\n', 3), ['', 'two', 'three']);
  file(join(root, 'slow'), '#!/bin/sh\nsleep 5\n');
  const slow = await run(join(root, 'slow'), [], { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.signal, 'SIGKILL');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const aborted = await run(join(root, 'slow'), [], { signal: ac.signal });
  assert.equal(aborted.signal, 'SIGTERM');
  await assert.rejects(run(join(root, 'missing'), []), /ENOENT/);
});

test('toJsonSchema', () => {
  const s = toJsonSchema(golden);
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['input']);
  const p = s.properties;
  assert.equal(p.help, undefined);
  assert.deepEqual(p.input, { type: 'string', description: 'Input file' });
  assert.deepEqual(p.mode, { type: 'string', enum: ['fast', 'slow'], description: 'Processing mode', default: 'fast' });
  assert.deepEqual(p.rest, { type: 'array', items: { type: 'string' }, description: 'Extra items' });
  assert.deepEqual(p.verbose, { type: 'boolean', description: 'Enable verbose output', default: false });
  assert.deepEqual(p.count, { type: 'integer', minimum: 1, maximum: 10, description: 'Number of iterations', default: 3 });
  assert.deepEqual(p.ratio, { type: 'number', minimum: 0, maximum: 1, description: 'Mix ratio', default: 0.5 });
  assert.equal(p.enabled.type, 'boolean');
  assert.equal(p.enabled.default, true);
  assert.deepEqual(p.tag.items, { type: 'string', minLength: 1, maxLength: 8 });
  assert.deepEqual([p.size.minLength, p.size.maxLength], [4, 4]);
  assert.deepEqual([p.port.minimum, p.port.maximum, p.port.default], [1, 65535, 8080]);
  assert.equal(p.code.pattern, '^[A-Z]{3}$');
  assert.match('2024-01-31', new RegExp(p.date.pattern));
  assert.match('10.0.0.1', new RegExp(p.addr.pattern));
  assert.doesNotMatch('mail@x', new RegExp(p.email.pattern));
  assert.ok(p.no_cache && p.data_dir && p.key);
});
