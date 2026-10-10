import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Cli } from '../../../packages/js/dist/esm/index.js';

// Exercise the real frontend module, including its formatting helpers.
const compiled = await build({ entryPoints: [new URL('../src/lib/utils.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { buildCommandArgs, formatCommandLine, parseCommandLine } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

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
