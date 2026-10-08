import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from 'clyops';

const { Cli, validate, resolvePath, wrapText, describeRule } = createRequire(import.meta.url)('clyops');

const make = () => new Cli({ name: 't', env: {}, cwd: '/work', root: '/root' })
  .getArg('file', 'File', '', 'path')
  .getOpt('COUNT', 'count', 'n', '2', 'Count', 'Options', 'int:1-5')
  .getOpt('FAST', 'fast', 'f', 'flag', 'Fast')
  .getOptArray('TAG', 'tag', 't', 'Tags');

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
  const cli = new Cli({ name: 't', env: { COUNT: '3' } }).getOpt('COUNT', 'count', '', '1', 'Count', 'Options', 'int');
  cli.parse([]);
  assert.equal(cli.get('COUNT'), 3);
  assert.equal(cli.source('count'), 'env');
});

test('registration errors throw', () => {
  assert.throws(() => new Cli().getOpt('A', 'a', '', '', 'A', 'Options', /** @type {any} */ ('nope')), /Unknown validation rule 'nope' for --a/);
  assert.throws(() => new Cli().getOpt('A', 'a', 'x', '', 'A').getOpt('B', 'b', 'x', '', 'B'), /duplicate short option -x/);
  assert.throws(() => new Cli().getArgVariadic('r', 'R').getArg('x', 'X'), /after a variadic/);
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
