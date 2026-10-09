// The committed single-file CommonJS bundle (clyops-tools.cjs) matches the ESM build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as esm from '../dist/index.js';

const require = createRequire(import.meta.url);
const golden = JSON.parse(readFileSync(new URL('../../../spec/conformance/golden/schema.json', import.meta.url), 'utf8'));

test('require() loads the bundle with the same exports', () => {
  const cjs = require('../clyops-tools.cjs');
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
  assert.equal(require.resolve('clyops-tools'), require.resolve('../clyops-tools.cjs'));
});

test('the bundle maps input like the ESM build', () => {
  const cjs = require('../clyops-tools.cjs');
  const input = { input: 'in.txt', mode: 'slow', count: 4, tag: ['a', 'b'], verbose: true, quiet: false };
  assert.deepEqual(cjs.toArgv(golden, input), esm.toArgv(golden, input));
  assert.deepEqual(cjs.toJsonSchema(golden), esm.toJsonSchema(golden));
});
