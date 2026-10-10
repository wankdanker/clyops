import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Cli } from '../../../packages/js/dist/esm/index.js';

// Exercise the real frontend module, including its formatting helpers.
const compiled = await build({ entryPoints: [new URL('../src/lib/utils.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { buildCommandArgs, formatCommandLine, parseCommandLine, initialFormValues } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function cli() {
  const cli = new Cli();
  cli.arg('input', 'Input');
  cli.opt('VERBOSE', 'verbose', '', 'flag', 'Verbose');
  return cli;
}

test('desktop positionals precede options unless a dash needs --', () => {
  for (const input of ['clip.wav', '-clip.wav', '--']) {
    const parser = cli();
    const schema = JSON.parse(parser.jsonSchema());
    const argv = buildCommandArgs(schema, { input, verbose: true });
    assert.deepEqual(argv, input.startsWith('-') ? ['--verbose', '--', input] : [input, '--verbose']);
    assert.equal(parser.parse(argv).status, 'ok');
    assert.equal(parser.values.input, input);
    assert.deepEqual(parseCommandLine(formatCommandLine('/tmp/tool', argv), schema), { input, verbose: true });
  }
});

test('checked and unchecked flags override both environment values', () => {
  for (const inherited of ['true', 'false']) {
    for (const value of [true, false]) {
      const parser = new Cli({ env: { DRY_RUN: inherited } });
      parser.opt('DRY_RUN', 'dry-run', '', 'flag', 'Dry run');
      const schema = JSON.parse(parser.jsonSchema());
      const argv = buildCommandArgs(schema, { 'dry-run': value });
      assert.deepEqual(argv, [value ? '--dry-run' : '--no-dry-run']);
      assert.equal(parser.parse(argv).status, 'ok');
      assert.equal(parser.values.DRY_RUN, value);
      assert.deepEqual(parseCommandLine(formatCommandLine('/tmp/tool', argv), schema), { 'dry-run': value });
    }
    const parser = new Cli({ env: { DRY_RUN: inherited } });
    parser.opt('DRY_RUN', 'dry-run', '', 'flag', 'Dry run');
    const schema = JSON.parse(parser.jsonSchema());
    assert.deepEqual(buildCommandArgs(schema, {}), []);
    assert.equal(parser.parse([]).status, 'ok');
    assert.equal(parser.values.DRY_RUN, inherited === 'true');
  }
});

test('saved templates restore displayed flags and produce the copied execution command', () => {
  for (const value of [true, false, 'true', 'false', 'YES', 'OFF', 1, 0]) {
    const parser = new Cli({ env: { DRY_RUN: 'true' } });
    parser.opt('DRY_RUN', 'dry-run', '', 'flag', 'Dry run');
    const schema = JSON.parse(parser.jsonSchema());
    const values = initialFormValues(schema, JSON.parse(JSON.stringify({ 'dry-run': value })));
    const checked = [true, 'true', 'YES', 1].includes(value);
    assert.equal(values['dry-run'], checked);
    const argv = buildCommandArgs(schema, values);
    assert.ok(argv.includes(checked ? '--dry-run' : '--no-dry-run'));
    const copiedValues = parseCommandLine(formatCommandLine('/tmp/tool', argv), schema);
    assert.deepEqual(buildCommandArgs(schema, copiedValues), argv);
    assert.equal(parser.parse(argv).status, 'ok');
    assert.equal(parser.values.DRY_RUN, checked);
  }
});

test('explicit negative and equals flag values import correctly', () => {
  const parser = cli();
  const schema = JSON.parse(parser.jsonSchema());
  assert.equal(parseCommandLine('/tmp/tool --no-verbose clip.wav', schema).verbose, false);
  assert.equal(parseCommandLine('/tmp/tool --verbose=false clip.wav', schema).verbose, false);
  assert.equal(parseCommandLine('/tmp/tool --verbose=YES clip.wav', schema).verbose, true);
});

test('copied argument text preserves shell metacharacters and empty values', () => {
  const schema = { script: 'tool', arguments: [{ name: 'input', isVariadic: false }], options: [{ name: 'tag', isArray: true }] };
  const args = ["$HOME `date` it's a file", '--tag', ''];
  const formatted = formatCommandLine('/tmp/tool', args);
  assert.ok(formatted.includes("'$HOME"));
  assert.deepEqual(parseCommandLine(formatted, schema), { input: args[0], tag: [''] });
});
