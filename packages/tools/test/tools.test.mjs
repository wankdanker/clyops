import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowed, checkWithin, classify, commands, discover, expandCommands, inputKeys, loadSchema, loadTools, redactArgv, run, runTool, start, startTool, tail, toArgv, toJsonSchema, watchTools } from '../dist/index.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const golden = JSON.parse(readFileSync(join(repo, 'spec/conformance/golden/schema.json'), 'utf8'));
const tasksGolden = JSON.parse(readFileSync(join(repo, 'spec/conformance/golden/tasks-schema.json'), 'utf8'));

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
    ['/base/in-world.txt', 'fast', 'r', '--config', '-', '--out', '/base/o.txt', '--include', '/base/a', '--include', '/abs', '--include', 'http://x/y'],
  );
  assert.throws(() => toArgv(golden, { mode: 'slow' }), /mode is given, so input must be too/);
  assert.deepEqual(toArgv(golden, { input: 'ignored', verbose: true }, { positionals: ['p1'] }).argv, ['p1', '--verbose']);
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

test('watchTools reloads when tools change', { timeout: 30_000 }, async () => {
  const root = tree();
  const sets = [];
  let wake = () => {};
  const watcher = await watchTools(root, { debounceMs: 50, onChange: (loaded) => { sets.push(loaded); wake(); } });
  // Resolve once a reload satisfies `check`.
  const until = (check) => new Promise((resolve) => {
    wake = () => sets.length && check(sets.at(-1)) && resolve(sets.at(-1));
    wake();
  });
  const names = (loaded) => loaded.tools.map((t) => t.words.join(' '));
  try {
    assert.ok(names(watcher.current()).includes('media to-pcm'));
    assert.ok(!names(watcher.current()).includes('media new'));
    // Not a tool: rescanned, but not reported.
    writeFileSync(join(root, 'notes.log'), 'x');

    file(join(root, 'media/new.sh'), readFileSync(join(root, 'demo.sh'), 'utf8'));
    await until((l) => names(l).includes('media new'));

    mkdirSync(join(root, 'extra'));
    file(join(root, 'extra/deep'), readFileSync(join(root, 'demo.sh'), 'utf8'));
    await until((l) => names(l).includes('extra deep'));

    writeFileSync(join(root, '.clyops'), 'description: Renamed\n');
    await until((l) => l.tree.description === 'Renamed');

    rmSync(join(root, 'media/new.sh'));
    const last = await until((l) => !names(l).includes('media new'));
    assert.equal(watcher.current(), last);
    assert.equal(sets.length, 4, 'one report per real change');
  } finally {
    watcher.close();
  }
});

test('expandCommands makes a tool of each command', () => {
  const cmd = { name: 'tasks', words: ['ops', 'tasks'], file: '/x/tasks', kind: 'tool' };
  const tools = expandCommands(cmd, tasksGolden);
  assert.deepEqual(tools.map((t) => t.words.join(' ')), ['ops tasks db migrate', 'ops tasks db status', 'ops tasks send']);
  const migrate = tools[0];
  assert.deepEqual(migrate.subcommand, ['db', 'migrate']);
  assert.equal(migrate.name, 'migrate');
  assert.equal(migrate.description, 'Apply migrations');
  assert.equal(migrate.schema.script, 'tasks db migrate');
  assert.deepEqual(migrate.schema.options.map((o) => o.name), ['dry-run', 'url', 'verbose', 'help']);
  assert.deepEqual(migrate.schema.arguments.map((a) => a.name), ['target']);
  assert.deepEqual(migrate.schema.effects, ['destructive']);
  const send = tools[2];
  assert.deepEqual(send.schema.constraints, [{ type: 'oneOf', options: ['webhook', 'email'] }]);
  assert.deepEqual(send.schema.stdin, { description: 'Attachment', contentType: 'application/octet-stream' });
  assert.deepEqual(expandCommands(cmd, golden).map((t) => [t.words, t.subcommand]), [[['ops', 'tasks'], undefined]]);
});

test('allowed: globs over words, deny wins, read-only', () => {
  const tool = (words, effects = []) => ({ words, schema: { effects } });
  assert.ok(allowed(tool(['media', 'to-pcm']), {}));
  assert.ok(allowed(tool(['media', 'to-pcm']), { allow: ['media/*'] }));
  assert.ok(!allowed(tool(['media', 'fp', 'index']), { allow: ['media/*'] }));
  assert.ok(allowed(tool(['media', 'fp', 'index']), { allow: ['media/**'] }));
  assert.ok(!allowed(tool(['admin', 'wipe']), { allow: ['**'], deny: ['admin/*'] }));
  assert.ok(!allowed(tool(['media', 'info']), { readOnly: true }));
  assert.ok(allowed(tool(['media', 'info'], ['read-only']), { readOnly: true }));
});

test('loadTools expands commands and applies the filter and the root settings', async () => {
  const root = tree();
  file(join(root, 'tasks'), `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/tasks.cjs')} "$@"\n`);
  const names = async (filter) => (await loadTools(root, { filter })).tools.map((t) => t.words.join(' ')).sort();
  assert.deepEqual((await names()).filter((n) => n.startsWith('tasks')), ['tasks db migrate', 'tasks db status', 'tasks send']);
  assert.deepEqual(await names({ readOnly: true }), ['tasks db status']);
  assert.deepEqual(await names({ allow: ['tasks/**'], deny: ['tasks/send'] }), ['tasks db migrate', 'tasks db status']);
  file(join(root, '.clyops'), 'description: Test tools\nignore: lib, skipped\nallow: media/*, tasks/db/*\ndeny: tasks/db/migrate\n', false);
  assert.deepEqual(await names(), ['media to-pcm', 'tasks db status']);
  assert.deepEqual(await names({ deny: ['media/*'] }), ['tasks db status'], 'both the settings and the filter apply');
});

test('runTool runs a command of a program', async () => {
  const root = tree();
  file(join(root, 'tasks'), `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/tasks.cjs')} "$@"\n`);
  const { tools } = await loadTools(root);
  const migrate = tools.find((t) => t.words.join(' ') === 'tasks db migrate');
  const result = await runTool(migrate, { target: '7', dry_run: true, verbose: true }, { cwd: root });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.json.values, { DRY_RUN: true, DB_URL: 'sqlite:app.db', VERBOSE: true, HELP: false, target: '7', command: ['db', 'migrate'] });
  assert.deepEqual(result.command.slice(1), ['db', 'migrate', '7', '--dry-run', '--verbose']);
});

test('secrets: redacted in the command, passed in the environment', async () => {
  assert.deepEqual(redactArgv(golden, ['--key', 's3cret', '--key=x', '--host', 'h', '--', '--key']), ['--key', '***', '--key=***', '--host', 'h', '--', '--key']);
  const { argv, env } = toArgv(golden, { input: 'in.txt', key: 's3cret' }, { secretEnv: true });
  assert.deepEqual([argv, env], [['in.txt'], { KEY: 's3cret' }]);
  assert.deepEqual(toArgv(golden, { key: 's3cret' }).argv, ['--key', 's3cret']);

  const root = tree();
  const tool = { name: 'demo', words: ['demo'], file: join(root, 'demo.sh'), kind: 'tool', schema: golden, description: '' };
  const envOnly = { PATH: process.env.PATH, DEMO_ROOT: root };
  const viaEnv = await runTool(tool, { input: 'in.txt', key: 's3cret' }, { cwd: root, env: envOnly });
  assert.equal(viaEnv.exitCode, 0, viaEnv.stderr);
  assert.equal(viaEnv.json.sources.key, 'env');
  assert.ok(!viaEnv.command.includes('s3cret'));
  const viaArgv = await runTool(tool, { input: 'in.txt', key: 's3cret' }, { cwd: root, env: envOnly, secretsInEnv: false });
  assert.equal(viaArgv.json.sources.key, 'cli');
  assert.deepEqual(viaArgv.command.slice(1), ['in.txt', '--key', '***']);
});

test('toJsonSchema marks secrets and exclusive options', () => {
  const s = toJsonSchema(golden);
  assert.equal(s.properties.key.writeOnly, true);
  assert.equal(s.properties.key.format, 'password');
  assert.deepEqual(s.allOf, [{
    not: { required: ['endpoint', 'addr'], properties: { endpoint: { not: { type: 'null' } }, addr: { not: { type: 'null' } } } },
    description: '--endpoint and --addr cannot be used together',
  }]);
});

test('within confines path inputs', () => {
  const root = tree();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-outside-')));
  symlinkSync(outside, join(root, 'escape'));
  assert.doesNotThrow(() => checkWithin('--src', 'media/new.txt', [root], root));
  assert.doesNotThrow(() => checkWithin('--src', '-', [root], '/'));
  assert.throws(() => checkWithin('--src', '../x', [root], root), (e) => e.status === 400 && /outside the allowed directories/.test(e.message));
  assert.throws(() => checkWithin('--src', 'escape/secret', [root], root), /outside/, 'symlinks are followed');
  assert.throws(() => checkWithin('--src', 'file:///etc/passwd', [root], root), /not a path/);
  assert.throws(() => toArgv(golden, { input: '/etc/passwd' }, { within: [root], cwd: root }), /input: \/etc\/passwd is outside/);
  assert.deepEqual(toArgv(golden, { input: 'in.txt', src: 'a' }, { within: [root], cwd: root }).argv, ['in.txt', '--src', 'a']);
});

test('run feeds stdin, keeps binary stdout and caps output', async () => {
  const root = tree();
  file(join(root, 'cat'), '#!/bin/sh\ncat\n');
  assert.equal((await run(join(root, 'cat'), [], { stdin: 'hello' })).stdout, 'hello');
  const { Readable } = await import('node:stream');
  assert.equal((await run(join(root, 'cat'), [], { stdin: Readable.from([Buffer.from('a'), Buffer.from('b')]) })).stdout, 'ab');
  const bytes = Buffer.from([0, 255, 1, 128]);
  const binary = await run(join(root, 'cat'), [], { stdin: bytes, stdout: 'buffer' });
  assert.deepEqual([binary.stdout, binary.stdoutBuffer], ['', bytes]);
  const capped = await run(join(root, 'cat'), [], { stdin: 'x'.repeat(100), maxOutput: 10 });
  assert.deepEqual([capped.stdout, capped.truncated], ['x'.repeat(10), true]);
  const started = start(join(root, 'cat'), [], { stdin: 'streamed', stdout: 'stream' });
  const chunks = [];
  for await (const c of started.stdout) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'streamed');
  assert.equal((await started.result).exitCode, 0);
  assert.throws(() => run(join(root, 'cat'), [], { stdout: 'stream' }), /use start/);
  const tool = { name: 'cat', words: ['cat'], file: join(root, 'cat'), kind: 'tool', schema: { ...golden, options: [], arguments: [] }, description: '' };
  assert.equal((await runTool(tool, {}, { stdin: '{"a":1}' })).json.a, 1);
  assert.equal(typeof startTool(tool, {}, { stdout: 'stream' }).stdout.pipe, 'function');
});

test('classification uses library syntax, never comments or documentation strings', () => {
  const root = tree();
  const cases = JSON.parse(readFileSync(join(repo, 'spec/conformance/detection.json'), 'utf8'));
  for (const c of cases) {
    const path = join(root, 'candidate');
    file(path, c.source);
    assert.equal(classify(path), c.tool ? 'tool' : 'other', c.name);
  }
});

test('loadTools never executes a packaging script that only mentions clyops', async () => {
  const root = tree();
  const marker = join(root, 'accidentally-ran');
  file(join(root, 'build-tarball.sh'), `#!/bin/sh\n# see scripts/lib/clyops.sh\necho damage > ${marker}\n`);
  assert.equal(classify(join(root, 'build-tarball.sh')), 'other');
  await loadTools(root);
  assert.throws(() => readFileSync(marker), /ENOENT/);
});

test('loadSchema rejects non-clyops JSON', async () => {
  const root = tree();
  file(join(root, 'fake'), '#!/bin/sh\n# clyops-tool\necho \'{"description":"not a schema","options":[],"arguments":[]}\'\n');
  await assert.rejects(loadSchema(join(root, 'fake')), /expected a clyops: 1 schema/);
});

test('hot reload does not re-probe unchanged files', async () => {
  const root = tree();
  const counter = join(root, 'probes.log');
  const path = join(root, 'counted.sh');
  const source = `#!/bin/sh\n# clyops-tool\necho probe >> ${counter}\nexec node ${join(repo, 'packages/js/examples/demo.cjs')} "$@"\n`;
  file(path, source);
  let wake;
  const changed = new Promise((resolve) => { wake = resolve; });
  const watcher = await watchTools(root, { debounceMs: 20, onChange: wake });
  try {
    file(join(root, 'added.sh'), readFileSync(join(root, 'demo.sh'), 'utf8'));
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('reload did not finish')), 5000).unref())]);
    assert.equal(readFileSync(counter, 'utf8'), 'probe\n');
  } finally { watcher.close(); }
});

test('toArgv supports both orders, with -- only for dash positionals', () => {
  for (const order of ['first', 'last']) {
    const options = { positionals: order };
    assert.deepEqual(toArgv(golden, { input: 'in.txt', verbose: true }, options).argv,
      order === 'first' ? ['in.txt', '--verbose'] : ['--verbose', 'in.txt']);
    for (const value of ['-clip.wav', '--', '--verbose']) {
      assert.deepEqual(toArgv(golden, { input: value, verbose: true }, options).argv, ['--verbose', '--', value]);
    }
    assert.deepEqual(toArgv(golden, { verbose: true }, options).argv, ['--verbose']);
  }
  assert.deepEqual(toArgv(golden, { verbose: true }, { positionals: ['p'], positionalsOrder: 'last' }).argv, ['--verbose', 'p']);
  assert.throws(() => toArgv(golden, {}, { positionals: 'sideways' }), /order must be first or last/);
});

test('toArgv renders and validates bare flags', () => {
  for (const value of [true, 'true', 'TRUE', 1, '1', 'yes', 'on']) {
    assert.deepEqual(toArgv(golden, { verbose: value }).argv, ['--verbose']);
  }
  for (const value of [false, 'false', 'FALSE', 0, '0', 'no', 'off']) {
    assert.deepEqual(toArgv(golden, { verbose: value }).argv, ['--no-verbose']);
  }
  for (const value of ['maybe', '', 2, [], ['true'], {}, { enabled: true }]) {
    assert.throws(() => toArgv(golden, { verbose: value }), (err) => err.status === 400 && /--verbose must be a boolean/.test(err.message));
  }
  assert.deepEqual(toArgv(golden, { verbose: '${flag}' }, { render: () => 'true' }).argv, ['--verbose']);
  assert.deepEqual(toArgv(golden, { verbose: '{{flag}}' }, { render: () => 'false' }).argv, ['--no-verbose']);
  assert.deepEqual(toArgv(golden, { verbose: null, quiet: undefined }).argv, []);
  const controlled = toArgv(golden, { verbose: 'invalid' }, { controlled: ['verbose'], render: () => { throw new Error('must not render'); } });
  assert.deepEqual(controlled.argv, []);
  assert.deepEqual(controlled.controlled, ['verbose']);
});
