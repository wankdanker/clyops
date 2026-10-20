import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Cli } from '../../js/dist/esm/index.js';
import { formFields, formSchema, toJsonSchema, constraintIssues, withoutSecrets, effectiveFds } from '../dist/index.js';

function program() {
  const cli = new Cli({ name: 'forms' });
  cli.arg('INPUT', 'Input file', '', 'file:exists');
  cli.argVariadic('EXTRA', 'More files', 'file:exists');
  cli.opt('COUNT', 'count', 'c', '3', 'Count', 'Options', 'int:0-10');
  cli.opt('RATIO', 'ratio', '', '0.5', 'Ratio', 'Options', 'float:0-1');
  cli.opt('MODE', 'mode', '', 'fast', 'Mode', 'Options', 'choice:fast,slow');
  cli.optArray('LEVEL', 'level', '', 'Levels', 'Options', 'int:1-5');
  cli.opt('DRY_RUN', 'dry-run', '', 'true', 'Dry run', 'Options', 'bool');
  cli.opt('KEY', 'key', '', 'optional', 'Key', 'Options', 'secret');
  cli.opt('WEBHOOK', 'webhook', '', 'optional', 'Webhook');
  cli.opt('EMAIL', 'email', '', 'optional', 'Email');
  cli.oneOf('webhook', 'email');
  cli.exclusive('webhook', 'email');
  cli.requires('webhook', 'key');
  cli.setEffects('read-only');
  return JSON.parse(cli.jsonSchema());
}

test('shared conversion gives typed scalar/array controls and preserves positional keys', () => {
  const schema = program();
  const fields = Object.fromEntries(formFields(schema).map(field => [field.key, field]));
  assert.equal(fields.INPUT.positional, true);
  assert.equal(fields.INPUT.path, true);
  assert.equal(fields.EXTRA.schema.type, 'array');
  assert.equal(fields.count.schema.minimum, 0);
  assert.equal(fields.count.schema.maximum, 10);
  assert.equal(fields.ratio.schema.type, 'number');
  assert.deepEqual(fields.mode.schema.enum, ['fast','slow']);
  assert.deepEqual(fields.level.schema.items, { type: 'integer', minimum: 1, maximum: 5 });
  assert.equal(fields.dry_run.schema.type, 'boolean');
  assert.equal(fields.key.secret, true);
  assert.equal(toJsonSchema(schema, 'declared').properties['dry-run'].type, 'boolean');
});

test('requirements are advisory for inherited inputs; explicit exclusivity is an error', () => {
  const schema = program();
  const notices = constraintIssues(schema, {});
  assert.equal(notices.length, 1);
  assert.equal(notices[0].severity, 'notice');
  assert.match(notices[0].message, /At least one/);
  const conflict = constraintIssues(schema, { webhook: 'url', email: 'name@example.com' });
  assert.ok(conflict.some(issue => issue.severity === 'error'));
  assert.ok(conflict.some(issue => issue.severity === 'notice' && issue.constraint.type === 'requires'));
  assert.deepEqual(constraintIssues(schema, { email: 'name@example.com' }), []);
  assert.deepEqual(formSchema(schema)['x-clyops'].constraints, schema.constraints);
  // Request schemas don't reject inputs that config/environment may complete.
  assert.equal(toJsonSchema(schema).anyOf, undefined);
});

test('secrets never enter defaults or templates; explicit false and zero survive', () => {
  const schema = program();
  schema.options.find(option => option.name === 'key').default = 'secret-default';
  assert.equal(toJsonSchema(schema).properties.key.default, undefined);
  assert.equal(toJsonSchema(schema).properties.key.writeOnly, true);
  assert.deepEqual(withoutSecrets(schema, { key: 'hidden', KEY: 'also-hidden', count: 0, dry_run: false, bogus: 'drop' }), { count: 0, dry_run: false });
});

test('exclusive boolean values count true as given and leave false inactive', () => {
  const cli = new Cli();
  cli.opt('A', 'a', '', 'false', 'A', 'Options', 'bool');
  cli.opt('B', 'b', '', 'false', 'B', 'Options', 'bool');
  cli.exclusive('a', 'b');
  const schema = JSON.parse(cli.jsonSchema());
  const input = toJsonSchema(schema);
  assert.deepEqual(input.allOf[0].not.properties.a, { const: true });
  assert.deepEqual(constraintIssues(schema, { a: false, b: true }), []);
  assert.equal(constraintIssues(schema, { a: true, b: true })[0].severity, 'error');
});

test('browser entry builds without Node built-ins or framework dependencies', async () => {
  const output = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.ok(Object.keys(output.metafile.inputs).every(file => !file.includes('node_modules')));
  assert.ok(output.outputFiles[0].text.includes('toJsonSchema'));
});

test('effectiveFds: nearest declaration wins by number, and takes over a role', () => {
  const cli = new Cli({ name: 'fds', env: {} })
    .fd(3, 'out', 'Progress', 'application/x-ndjson', 'progress')
    .fd(5, 'out', 'Log', '', 'log');
  const db = cli.command('db', 'Database');
  db.command('migrate', 'Migrate').fd(4, 'out', 'Migration progress', '', 'progress').fd(5, 'in', 'Plan');
  const schema = JSON.parse(cli.jsonSchema());
  assert.deepEqual(effectiveFds(schema).map((d) => [d.fd, d.role]), [[3, 'progress'], [5, 'log']]);
  assert.deepEqual(effectiveFds(schema, ['db']).map((d) => [d.fd, d.role]), [[3, 'progress'], [5, 'log']]);
  assert.deepEqual(effectiveFds(schema, ['db', 'migrate']).map((d) => [d.fd, d.role, d.direction]),
    [[3, '', 'out'], [4, 'progress', 'out'], [5, '', 'in']]);
  assert.deepEqual(formSchema(schema)['x-clyops'].fds, schema.fds);
  assert.deepEqual(effectiveFds({ ...schema, fds: undefined }), []);
});
