import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Cli } from '../../js/dist/esm/index.js';
import { formFields, formSchema, toJsonSchema, constraintIssues, withoutSecrets, effectiveRoles, fdsEnv, parseJsonInputs, checkableInputSchema } from '../dist/index.js';

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

test('effectiveRoles: the nearest declaration wins by name', () => {
  const cli = new Cli({ name: 'roles', env: {} })
    .role('progress', 'out', 'Progress', 'application/x-ndjson')
    .role('log', 'out', 'Log');
  const db = cli.command('db', 'Database');
  db.command('migrate', 'Migrate').role('progress', 'out', 'Migration progress').role('plan', 'in', 'Plan');
  const schema = JSON.parse(cli.jsonSchema());
  assert.deepEqual(effectiveRoles(schema).map((r) => r.name), ['progress', 'log']);
  assert.deepEqual(effectiveRoles(schema, ['db', 'migrate']).map((r) => [r.name, r.description]),
    [['progress', 'Migration progress'], ['log', 'Log'], ['plan', 'Plan']]);
  assert.deepEqual(formSchema(schema)['x-clyops'].roles, schema.roles);
  assert.deepEqual(effectiveRoles({ ...schema, roles: undefined }), []);
  assert.equal(fdsEnv({ progress: 4, meta: 3 }), 'progress:4,meta:3');
});

test('a json:SCHEMA input is its schema, with references pointed into the input and URLs not fetched', () => {
  const cli = new Cli({ name: 'events' });
  const event = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.com/event.json', type: 'object',
    properties: { at: { $ref: '#/$defs/time' }, by: { $ref: 'https://example.com/user.json', description: 'Who' } }, $defs: { time: { type: 'string' } } };
  cli.opt('EVENT', 'event', '', 'optional', 'The event', '', `json:${JSON.stringify(event)}`);
  cli.optArray('NODE', 'node', '', 'Nodes', '', 'json:{"type":"object","properties":{"next":{"$ref":"#"}}}');
  cli.opt('ANY', 'any', '', '{"a": 1}', 'Anything', '', 'json');
  cli.opt('LATER', 'later', '', 'optional', 'Fetched by nobody', '', 'json:https://example.com/later.json');
  const p = toJsonSchema(JSON.parse(cli.jsonSchema())).properties;
  assert.deepEqual(p.event, {
    type: 'object', properties: { at: { $ref: '#/properties/event/$defs/time' }, by: { $comment: 'JSON Schema: https://example.com/user.json', description: 'Who' } },
    $defs: { time: { type: 'string' } }, contentMediaType: 'application/json', description: 'The event',
  });
  assert.deepEqual(p.node.items, { type: 'object', properties: { next: { $ref: '#/properties/node/items' } }, contentMediaType: 'application/json' });
  assert.deepEqual(p.any, { contentMediaType: 'application/json', description: 'Anything', default: { a: 1 } });
  assert.deepEqual(p.later, { $comment: 'JSON Schema: https://example.com/later.json', contentMediaType: 'application/json', description: 'Fetched by nobody' });

  const input = toJsonSchema(JSON.parse(cli.jsonSchema()));
  assert.deepEqual(parseJsonInputs(input, { any: '{"a": [1]}', event: { at: 'x' }, node: ['{}', { next: {} }], other: '{' }),
    { value: { any: { a: [1] }, event: { at: 'x' }, node: [{}, { next: {} }], other: '{' } });
  assert.deepEqual(parseJsonInputs(input, { node: ['{'] }), { error: 'node must be valid JSON' });
});

test('a json input whose schema does not compile is left unchecked, and reported', () => {
  const cli = new Cli({ name: 'broken' });
  cli.opt('BAD', 'bad', '', '', 'Bad type', '', 'json:{"type":"nonsense"}');
  cli.optArray('REFS', 'refs', '', 'Refs to nothing', '', 'json:{"$ref":"#/nope"}');
  cli.opt('GOOD', 'good', '', '{"w": 1}', 'Fine', '', 'json:{"type":"object"}');
  cli.opt('NAME', 'name', '', '', 'Not json', '');
  const input = toJsonSchema(JSON.parse(cli.jsonSchema()));
  // Stands in for ajv: it rejects an unknown type and a reference to nothing.
  const compile = (schema) => {
    const text = JSON.stringify(schema);
    if (text.includes('"nonsense"')) throw new Error('type must be JSONType or JSONType[]: nonsense');
    if (text.includes('/nope"')) throw new Error("can't resolve reference");
    return () => true;
  };
  const reported = [];
  const out = checkableInputSchema(input, compile, (key, err) => reported.push(`${key}: ${err.message}`));
  assert.deepEqual(reported, ['bad: type must be JSONType or JSONType[]: nonsense', "refs: can't resolve reference"]);
  assert.deepEqual(out.properties.bad, { contentMediaType: 'application/json', description: 'Bad type' });
  assert.deepEqual(out.properties.refs, { type: 'array', items: { contentMediaType: 'application/json' }, description: 'Refs to nothing' });
  assert.deepEqual(out.properties.good, input.properties.good);
  assert.deepEqual(out.properties.name, input.properties.name);
  assert.equal(checkableInputSchema(out, compile), out);
});
