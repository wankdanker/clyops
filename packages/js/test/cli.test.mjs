import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from 'clyops';

const { Cli, validate, resolvePath, wrapText, describeRule } = createRequire(import.meta.url)('clyops');

const make = () => new Cli({ name: 't', env: {}, cwd: '/work', root: '/root' })
  .arg('file', 'File', '', 'path')
  .opt('COUNT', 'count', 'n', '2', 'Count', 'Options', 'int:1-5')
  .opt('FAST', 'fast', 'f', 'flag', 'Fast')
  .optArray('TAG', 'tag', 't', 'Tags');

test('ESM and CJS builds export the same API', () => {
  assert.equal(typeof esm.Cli, 'function');
  assert.equal(typeof esm.validate, 'function');
});

test('parse returns typed values without exiting', () => {
  const cli = make();
  assert.deepEqual(cli.parse(['a.txt', '-fn', '4', '-t', 'x', '--tag=y']), { status: 'ok' });
  assert.equal(cli.get('file'), '/work/a.txt');
  assert.equal(cli.get('COUNT'), 4);
  assert.equal(cli.get('FAST'), true);
  assert.deepEqual(cli.get('TAG'), ['x', 'y']);
  assert.equal(cli.source('count'), 'cli');
  assert.equal(cli.isSet('--fast'), true);
  assert.equal(cli.isExplicitlySet('tag'), true);
});

test('parse reports errors and help without exiting', () => {
  assert.deepEqual(make().parse(['a', '--count', '9']),
    { status: 'error', error: '--count must be <= 5, got 9', showUsage: true });
  assert.deepEqual(make().parse(['--help']), { status: 'help' });
});

test('environment is read by variable name', () => {
  const cli = new Cli({ name: 't', env: { COUNT: '3' } }).opt('COUNT', 'count', '', '1', 'Count', 'Options', 'int');
  cli.parse([]);
  assert.equal(cli.get('COUNT'), 3);
  assert.equal(cli.source('count'), 'env');
});

test('deprecated get* aliases register the same way', () => {
  const cli = new Cli({ name: 't', env: {} })
    .getArg('file', 'File').getArgVariadic('rest', 'Rest')
    .getOpt('N', 'n', '', '1', 'N', 'Options', 'int').getOptArray('T', 't', '', 'Tags');
  assert.deepEqual(cli.parse(['a', 'b', '--n', '2', '--t', 'x']), { status: 'ok' });
  assert.deepEqual([cli.get('file'), cli.get('rest'), cli.get('N'), cli.get('T')], ['a', ['b'], 2, ['x']]);
});

test('registration errors throw', () => {
  assert.throws(() => new Cli().opt('A', 'a', '', '', 'A', 'Options', /** @type {any} */ ('nope')), /Unknown validation rule 'nope' for --a/);
  assert.throws(() => new Cli().opt('A', 'a', 'x', '', 'A').opt('B', 'b', 'x', '', 'B'), /duplicate short option -x/);
  assert.throws(() => new Cli().argVariadic('r', 'R').arg('x', 'X'), /after a variadic/);
});

test('validate converts and explains', () => {
  assert.equal(validate('0x', 'regex:^0', 'v'), '0x');
  assert.equal(validate('ON', 'bool', 'v'), true);
  assert.equal(validate('-2.5', 'float:-3', 'v'), -2.5);
  assert.throws(() => validate('abcd', 'string:-3', '--s'), /--s must be at most 3 characters, got 4/);
  assert.equal(describeRule('string:2-'), 'text: >=2 chars');
});

test('resolvePath passes through special values', () => {
  assert.equal(resolvePath('-', '/b'), '-');
  assert.equal(resolvePath('s3://bucket/key', '/b'), 's3://bucket/key');
  assert.equal(resolvePath('../x', '/b/c'), '/b/x');
});

test('wrapText keeps paragraphs and long words', () => {
  assert.deepEqual(wrapText('aa bb cc\n\nsupercalifragilistic dd', 5), ['aa bb', 'cc', '', 'supercalifragilistic', 'dd']);
});

test('registration errors for effects, constraints and commands', () => {
  assert.throws(() => new Cli({ name: 't' }).setEffects('sideways'), /Unknown effect 'sideways'/);
  assert.throws(() => new Cli({ name: 't' }).opt('A', 'a', '', 'flag', 'A').exclusive('a', 'b'), /Unknown option --b in constraint/);
  assert.throws(() => new Cli({ name: 't' }).arg('x', 'X').command('c', 'C'), /Cannot mix commands and positional arguments/);
  assert.throws(() => { const c = new Cli({ name: 't' }); c.command('c', 'C'); c.arg('x', 'X'); }, /Cannot mix/);
});

test('secret options keep their value but print masked', () => {
  const cli = new Cli({ name: 't', env: {} }).opt('TOKEN', 'token', '', '', 'Token', 'Auth', 'secret:string:3-')
    .optArray('PW', 'pw', '', 'Passwords', 'Auth', 'secret');
  assert.deepEqual(cli.parse(['--token', 'abcd', '--pw', 'x', '--pw', 'y']), { status: 'ok' });
  assert.equal(cli.get('TOKEN'), 'abcd');
  assert.deepEqual(JSON.parse(cli.valuesJson()), { TOKEN: '***', PW: ['***', '***'], HELP: false });
  assert.equal(cli.parse(['--token', 'ab']).status, 'error');
  const schema = JSON.parse(cli.jsonSchema());
  assert.equal(schema.options[0].secret, true);
  assert.equal(schema.options[0].validation, 'string:3-');
  assert.match(cli.usage(), /Token \(required, secret, accepts: text: >=3 chars\)/);
});

test('relationships: given means set explicitly and not false', () => {
  const make2 = (env = {}) => new Cli({ name: 't', env })
    .opt('A', 'a', 'a', 'flag', 'A').opt('B', 'b', 'b', 'flag', 'B').opt('C', 'c', 'c', 'optional', 'C')
    .exclusive('a', 'b').requires('c', 'a').oneOf('a', 'b', 'c');
  assert.equal(make2().parse(['-a', '-b']).error, 'Options --a and --b cannot be used together');
  assert.equal(make2().parse(['-a', '--no-b']).status, 'ok');
  assert.equal(make2().parse(['-c', 'x']).error, 'Option --c requires --a');
  assert.equal(make2({ A: 'true' }).parse(['-c', 'x']).status, 'ok');
  assert.equal(make2().parse([]).error, 'One of --a, --b, --c is required');
  assert.equal(make2().parse(['--no-a']).error, 'One of --a, --b, --c is required');
});

test('effects, stdin and stdout are in the schema and help', () => {
  const cli = new Cli({ name: 't' }).setEffects('read-only', 'network').setStdin('Audio', 'audio/wav,audio/flac').setStdout('', 'audio/mpeg');
  const schema = JSON.parse(cli.jsonSchema());
  assert.deepEqual(schema.effects, ['read-only', 'network']);
  assert.deepEqual(schema.stdin, { description: 'Audio', contentType: 'audio/wav,audio/flac' });
  assert.deepEqual(schema.stdout, { description: '', contentType: 'audio/mpeg' });
  assert.match(cli.usage(), /\n\nInput: Audio \(audio\/wav,audio\/flac\)\nOutput: \(audio\/mpeg\)\n\n/);
});

test('commands: scanning, values and the chain', () => {
  const cli = new Cli({ name: 'm', env: {} }).opt('CONFIG', 'config', 'c', 'optional', 'Config', 'Global');
  const db = cli.command('db', 'Database');
  const migrate = db.command('migrate', 'Migrate').opt('TO', 'to', '', 'optional', 'Target', 'Options', 'int');
  migrate.arg('name', 'Name', 'all');
  assert.deepEqual(cli.parse(['db', '-c', 'x', 'migrate', '--to', '3']), { status: 'ok' });
  assert.deepEqual(cli.commandPath, ['db', 'migrate']);
  assert.deepEqual({ ...cli.values }, { TO: 3, CONFIG: 'x', HELP: false, name: 'all', command: ['db', 'migrate'] });
  assert.equal(cli.source('to'), 'cli');
  assert.equal(cli.parse(['--to', '3', 'db', 'migrate']).error, 'Unknown option: --to');
  assert.equal(cli.parse(['db']).error, 'Missing command');
  assert.equal(cli.parse(['db', 'seed']).error, 'Unknown command: seed');
  assert.deepEqual(cli.parse(['db', 'migrate', '--help']), { status: 'help' });
  assert.match(cli.usage(), /^Usage: m db migrate \[<name>\] \[OPTIONS\]/);
  const schema = JSON.parse(cli.jsonSchema());
  assert.equal(schema.commands[0].name, 'db');
  assert.equal(schema.commands[0].commands[0].options[0].name, 'to');
  assert.equal(schema.commands[0].commands[0].arguments[0].name, 'name');
});

test('roles: registration errors', () => {
  const cli = () => new Cli({ name: 't', env: {} });
  assert.throws(() => cli().role('7up', 'out', 'X'), /Invalid role name '7up'/);
  assert.throws(() => cli().role('a:b', 'out', 'X'), /Invalid role name 'a:b'/);
  assert.throws(() => cli().role('log', /** @type {any} */ ('both'), 'X'), /Unknown role direction 'both'/);
  assert.throws(() => cli().role('log', 'out', 'X').role('log', 'in', 'Y'), /Duplicate role 'log'/);
  assert.doesNotThrow(() => cli().role('progress', 'out', 'X').role('my.role-2_x', 'in', 'Y'));
});

test('roles: schema accepts an object or JSON text', () => {
  const cli = new Cli({ name: 't', env: {} })
    .role('meta', 'out', 'A', 'application/json', { type: 'object' })
    .role('extra', 'in', 'B', '', '{"type":"string"}');
  assert.deepEqual(JSON.parse(cli.jsonSchema()).roles, [
    { name: 'meta', direction: 'out', description: 'A', contentType: 'application/json', schema: { type: 'object' } },
    { name: 'extra', direction: 'in', description: 'B', contentType: '', schema: { type: 'string' } },
  ]);
});

test('roles: emit and forwardFds follow the CLYOPS_FDS mapping', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fsm = await import('node:fs');
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), 'clyops-fd-'));
  const file = path.join(dir, 'out');
  const fd = fsm.openSync(file, 'w');
  try {
    const make = (env) => {
      const c = new Cli({ name: 't', env }).role('progress', 'out', 'Progress').role('extra', 'in', 'Extra');
      assert.deepEqual(c.parse([]), { status: 'ok' });
      return c;
    };
    const unmapped = make({});
    assert.equal(unmapped.fdOpen('progress'), null);
    unmapped.emit('progress', { pct: 1 });
    assert.equal(unmapped.forwardFds('progress'), '');
    const cli = make({ CLYOPS_FDS: `progress:${fd}, extra:999, log:${fd}` });
    assert.equal(cli.fdOpen('progress'), fd);
    assert.equal(cli.fdOpen('extra'), null, 'mapped but not open');
    assert.equal(cli.fdOpen('log'), null, 'mapped but not declared');
    cli.emit('progress', { pct: 50 });
    cli.emit('progress', 'plain text');
    cli.emit('progress', 'ends with newline\n');
    assert.equal(cli.forwardFds('progress', 'extra', 'log', 'nope'), `progress:${fd},log:${fd}`);
    assert.throws(() => cli.emit('nope', 'x'), /Unknown role 'nope'/);
    assert.throws(() => cli.emit('extra', 'x'), /Role 'extra' is not an output/);
  } finally {
    fsm.closeSync(fd);
  }
  assert.equal(fsm.readFileSync(file, 'utf8'), '{"pct":50}\nplain text\nends with newline\n');
  fsm.rmSync(dir, { recursive: true });
});

test('roles: CLYOPS_FDS is read once and removed from the process environment', () => {
  process.env.CLYOPS_FDS = 'progress:2';
  const cli = new Cli({ name: 't' }).role('progress', 'out', 'Progress');
  cli.parse([]);
  assert.equal(process.env.CLYOPS_FDS, undefined);
  cli.parse([]);
  assert.equal(cli.fdOpen('progress'), 2, 'the mapping outlives the variable');
  const own = { CLYOPS_FDS: 'progress:2' };
  process.env.CLYOPS_FDS = 'other:5';
  new Cli({ name: 't', env: own }).parse([]);
  assert.equal(process.env.CLYOPS_FDS, 'other:5', 'only a variable holding the value read is removed');
  delete process.env.CLYOPS_FDS;
});

test('roles: commands inherit, help lists their own', () => {
  const cli = new Cli({ name: 'm', env: { CLYOPS_FDS: 'progress:2,plan:2' } }).role('progress', 'out', 'Progress', 'application/x-ndjson');
  const db = cli.command('db', 'Database');
  db.command('migrate', 'Migrate').role('plan', 'out', 'Migration plan');
  db.command('status', 'Status');
  cli.parse(['db', 'status']);
  assert.equal(cli.fdOpen('progress'), 2);
  assert.equal(cli.fdOpen('plan'), null, 'declared on a sibling');
  cli.parse(['db', 'migrate']);
  assert.equal(cli.fdOpen('plan'), 2);
  assert.match(cli.usage(), /\nOutput \[plan\]: Migration plan\n/);
  assert.doesNotMatch(cli.usage(), /\[progress\]/);
});
