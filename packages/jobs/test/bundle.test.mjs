// The committed single-file CommonJS bundle (clyops-jobs.cjs, which includes
// clyops-tools) matches the ESM build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/index.js';

const require = createRequire(import.meta.url);

test('require() loads the bundle with the same exports', () => {
  const cjs = require('../clyops-jobs.cjs');
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
  assert.equal(require.resolve('clyops-jobs'), require.resolve('../clyops-jobs.cjs'));
});

test('the bundle renders templates and runs a queued job', async () => {
  const cjs = require('../clyops-jobs.cjs');
  const ctx = { job: { id: 'j1' }, media: { path: '/in/a.wav' } };
  assert.equal(cjs.renderTemplateString('${job.id}:{{media.path}}', ctx), esm.renderTemplateString('${job.id}:{{media.path}}', ctx));
  const queue = new cjs.JobQueue({ concurrency: 1, prefix: 'b' });
  const job = queue.add('f', async () => 42);
  assert.equal(await job.done, 42);
  assert.equal(job.record.status, 'done');
  assert.match(job.record.job_id, /^b-[0-9a-f]{12}$/);
});
