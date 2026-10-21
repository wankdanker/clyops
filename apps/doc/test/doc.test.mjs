import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cli } from 'clyops';
import { buildDoc, defaultDate, document, firstSentence, leaves, markdownText, troff } from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const schemaOf = (file) => JSON.parse(execFileSync(process.execPath, [join(repo, file), '--help-json-schema'], { encoding: 'utf8' }));
const tasks = schemaOf('packages/js/examples/tasks.cjs');
const demo = schemaOf('packages/js/examples/demo.cjs');
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
const hasGroff = spawnSync('groff', ['--version']).status === 0;

/** groff's warnings for a man page (none expected); skipped where groff isn't installed. */
function groffWarnings(page) {
  return spawnSync('groff', ['-man', '-Tutf8', '-ww', '-z'], { input: page, encoding: 'utf8' }).stderr;
}

test('documents itself: its own schema on stdin gives its man page', () => {
  const schema = run(['--help-json-schema']);
  assert.equal(schema.status, 0, schema.stderr);
  const page = run(['--date', '2026-10-21', '--version', '1.2.3'], schema.stdout);
  assert.equal(page.status, 0, page.stderr);
  assert.match(page.stdout, /^\.TH "CLYOPS\\-DOC" "1" "2026\\-10\\-21" "clyops\\-doc 1\.2\.3" "User Commands"$/m);
  assert.match(page.stdout, /^\.SH "SYNOPSIS"$/m);
  assert.match(page.stdout, /\\fB\\-f, \\-\\-format=<value>\\fR/);
  if (hasGroff) assert.equal(groffWarnings(page.stdout), '');
  const parsed = JSON.parse(schema.stdout);
  assert.deepEqual(parsed.effects, ['read-only']);
  assert.equal(parsed.stdin.contentType, 'application/json');
});

test('rejects input that is not a clyops schema, with exit 1', () => {
  const notJson = run([], 'nope');
  assert.equal(notJson.status, 1);
  assert.match(notJson.stderr, /Could not read the schema/);
  const notClyops = run([], '{"openapi":"3.1.0"}');
  assert.equal(notClyops.status, 1);
  assert.match(notClyops.stderr, /not a clyops schema/);
  assert.throws(() => buildDoc({ clyops: 2, options: [], arguments: [] }), /not a clyops schema/);
});

test('a schema file, --name for a dispatcher path, and every format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clyops-doc-'));
  try {
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(demo));
    for (const format of ['man', 'markdown', 'html']) {
      const out = run(['--schema', join(dir, 'schema.json'), '--name', 'mytool media demo', '--format', format, '--date', '2026-01-02']);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /mytool media demo/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commands: one subsection per runnable command, with what it inherits', () => {
  assert.deepEqual(leaves(tasks).map((l) => l.words.join(' ')), ['db migrate', 'db status', 'send']);
  const migrate = leaves(tasks)[0];
  assert.deepEqual(migrate.options.map((o) => o.name), ['dry-run', 'url', 'verbose', 'help']);
  assert.deepEqual(migrate.roles.map((r) => r.name), ['progress', 'plan']);
  assert.deepEqual(migrate.effects, ['destructive']);
  const md = document(tasks, 'markdown', { date: '2026-10-21' });
  assert.match(md, /```\ntasks db migrate \[<target>\] \[OPTIONS\]\ntasks db status \[OPTIONS\]\ntasks send <message> \[OPTIONS\]\n```/);
  assert.match(md, /### `tasks db migrate`\n\nApply migrations/);
  assert.match(md, /- `output role plan`: Migration plan \(text\/plain\)/);
  assert.match(md, /- `CLYOPS_FDS`: Maps roles to file descriptors/);
  assert.match(md, /At least one of --webhook, --email\./);
  const man = document(tasks, 'man', { date: '2026-10-21' });
  assert.match(man, /^\.SS "tasks db migrate"$/m);
  if (hasGroff) assert.equal(groffWarnings(man), '');
});

test('a program: arguments, options, streams, notes, environment, exit status and examples', () => {
  const doc = buildDoc(demo, { date: '2026-10-21' });
  assert.deepEqual(doc.sections.map((s) => s.title),
    ['NAME', 'SYNOPSIS', 'DESCRIPTION', 'ARGUMENTS', 'OPTIONS', 'STREAMS', 'NOTES', 'ENVIRONMENT', 'EXIT STATUS', 'EXAMPLES']);
  const md = document(demo, 'markdown', { date: '2026-10-21' });
  assert.match(md, /- `-k, --key=<value>`: API key \(required; secret: prefer the environment; environment: KEY\)/);
  assert.match(md, /- `<rest\.\.\.>`: Extra items \(any number\)/);
  assert.match(md, /Giving --dest requires --src\./);
  assert.match(md, /Needs sh on PATH: POSIX shell \(install dash\)\./);
  assert.match(md, /## EXAMPLES\n\n```\nExamples:\n  demo in\.txt slow a b --tag x --tag y/);
  assert.doesNotMatch(md, /`HELP`/, 'the built-in --help has no environment variable worth listing');
});

test('escaping: troff, Markdown and HTML render text as itself', () => {
  assert.equal(troff('.start and \'quote\nback\\slash --long'), '\\&.start and \'quote\nback\\eslash \\-\\-long');
  assert.equal(troff("'leading quote"), "\\&'leading quote");
  assert.equal(markdownText('DRY_RUN (default: 1) *not bold* _x_ <tag> [link](u)'), 'DRY_RUN (default: 1) \\*not bold\\* \\_x\\_ \\<tag\\> \\[link\\](u)');
  assert.equal(markdownText('# not a heading\n- not a list\n1. not a list'), '\\# not a heading\n\\- not a list\n\\1. not a list');
  const nasty = new Cli({ name: 'x', env: {} });
  nasty.setDescription('<script>alert(1)</script> & ".dot"');
  nasty.opt('A', 'a', '', 'optional', 'Uses `backticks` and \\ backslash');
  const schema = JSON.parse(nasty.jsonSchema());
  const html = document(schema, 'html', { date: '2026-10-21' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;\.dot&quot;/);
  const man = document(schema, 'man', { date: '2026-10-21' });
  assert.match(man, /Uses `backticks` and \\e backslash/);
  if (hasGroff) assert.equal(groffWarnings(man), '');
});

test('the NAME line, and the header date', () => {
  assert.equal(firstSentence('Render docs. Then more.'), 'Render docs');
  assert.equal(firstSentence('v1.2 is fine: no sentence end'), 'v1.2 is fine: no sentence end');
  assert.equal(defaultDate({ SOURCE_DATE_EPOCH: '1700000000' }), '2023-11-14');
  assert.match(defaultDate({}), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(document(tasks, 'man', { section: '8', date: '2026-10-21' }), /^\.TH "TASKS" "8" /m);
});
