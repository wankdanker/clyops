import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cli } from 'clyops';
import { buildDoc, defaultDate, document, firstSentence, leaves, markdownText, pageName, pages, troff } from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const schemaOf = (file) => JSON.parse(execFileSync(process.execPath, [join(repo, file), '--help-json-schema'], { encoding: 'utf8' }));
const tasks = schemaOf('packages/js/examples/tasks.cjs');
const demo = schemaOf('packages/js/examples/demo.cjs');
const run = (args, input, env) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
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
  assert.deepEqual(parsed.effects, ['idempotent', 'destructive'], 'it can write files, with --out-dir and --execute');
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

test('a program: arguments, options, streams, notes, environment, files, exit status and examples', () => {
  const doc = buildDoc(demo, { date: '2026-10-21' });
  assert.deepEqual(doc.sections.map((s) => s.title),
    ['NAME', 'SYNOPSIS', 'DESCRIPTION', 'ARGUMENTS', 'OPTIONS', 'STREAMS', 'NOTES', 'ENVIRONMENT', 'FILES', 'EXIT STATUS', 'EXAMPLES']);
  const md = document(demo, 'markdown', { date: '2026-10-21' });
  assert.match(md, /- `-k, --key=<value>`: API key \(required; secret: set it in the environment, never on the command line; environment: KEY\)/);
  assert.match(md, /- `<rest\.\.\.>`: Extra items \(any number\)/);
  assert.match(md, /Giving --dest requires --src\./);
  assert.match(md, /Needs sh on PATH: POSIX shell \(install dash\)\./);
  assert.match(md, /## EXAMPLES\n\n```\nExamples:\n  demo in\.txt slow a b --tag x --tag y/);
  assert.doesNotMatch(md, /`HELP`/, 'the built-in --help has no environment variable worth listing');
});

test('files: the declared config file, and none without one', () => {
  const md = document(demo, 'markdown', { date: '2026-10-21' });
  assert.match(md, /## FILES\n\nThe config file is the one named by --config or CONFIG, resolved against the current directory\./);
  assert.match(md, /one key=value per line, on lines starting with demo: or shared:\./);
  assert.match(md, /```\ndemo:color=auto\n```/);
  assert.match(md, /command line takes precedence over the config file/);
  const plain = document(tasks, 'markdown', { date: '2026-10-21' });
  assert.doesNotMatch(plain, /## FILES|config file/);
  const older = document({ ...demo, config: undefined }, 'markdown', { date: '2026-10-21' });
  assert.doesNotMatch(older, /## FILES/, 'a schema from before 0.7 has no config field');
  const every = buildDoc({ ...demo, config: { option: 'config', prefixes: [] } }, { date: '2026-10-21' });
  const files = every.sections.find((s) => s.title === 'FILES');
  assert.match(files.blocks[1].text, /^It sets options with one key=value per line\. /);
  assert.equal(files.blocks[2].text, 'color=auto');
  if (hasGroff) assert.equal(groffWarnings(document(demo, 'man', { date: '2026-10-21' })), '');
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

test('split: a page per command, git-style, each with what it inherits and SEE ALSO', () => {
  assert.equal(pageName('tasks', ['db', 'migrate']), 'tasks-db-migrate');
  assert.equal(pageName('mytool media'), 'mytool-media');
  const man = pages(tasks, 'man', { date: '2026-10-21' });
  assert.deepEqual(man.map((p) => p.file), ['tasks.1', 'tasks-db-migrate.1', 'tasks-db-status.1', 'tasks-send.1']);
  const [top, migrate] = man.map((p) => p.content);
  assert.match(top, /^\.TH "TASKS" "1"/m);
  assert.match(top, /^\\fBtasks db migrate\\fR\nApply migrations\. See tasks\\-db\\-migrate\(1\)\.$/m);
  assert.match(top, /^\.SH "OPTIONS"\n\.PP\nAccepted by every command\.\n\.TP\n\\fB\\-v, \\-\\-verbose\\fR$/m);
  assert.match(top, /^\.BR "tasks\\-db\\-migrate" "\(1\),"\n\.BR "tasks\\-db\\-status" "\(1\),"\n\.BR "tasks\\-send" "\(1\)"$/m);
  assert.doesNotMatch(top, /DB_URL/, 'the top page lists only the program\'s own variables');
  assert.match(migrate, /^\.TH "TASKS\\-DB\\-MIGRATE" "1"/m);
  assert.match(migrate, /^\.SH "NAME"\ntasks\\-db\\-migrate \\- Apply migrations$/m);
  assert.match(migrate, /^tasks db migrate \[<target>\] \[OPTIONS\]$/m);
  assert.match(migrate, /\\fB\\-v, \\-\\-verbose\\fR/, 'inherited options are on the command\'s page');
  assert.match(migrate, /Effects: destructive/);
  assert.match(man[2].content, /Effects: read\\-only/);
  assert.match(pages({ ...tasks, effects: [], commands: [] }, 'man')[0].content, /Effects: not declared, so treat it as possibly destructive\./);
  assert.match(migrate, /^\.SH "SEE ALSO"\n\.PP\n\.BR "tasks" "\(1\)"$/m);
  if (hasGroff) for (const p of man) assert.equal(groffWarnings(p.content), '', p.file);

  const md = pages(tasks, 'markdown', { date: '2026-10-21', section: '8' });
  assert.deepEqual(md.map((p) => p.file), ['tasks.md', 'tasks-db-migrate.md', 'tasks-db-status.md', 'tasks-send.md']);
  assert.match(md[0].content, /\[tasks-db-migrate\(8\)\]\(tasks-db-migrate\.md\)/);
  assert.match(pages(tasks, 'html')[1].content, /<a href="tasks\.html"><code>tasks<\/code>\(1\)<\/a>/);
  assert.deepEqual(pages(demo, 'man').map((p) => p.file), ['demo.1'], 'a program without commands is one page');
  assert.deepEqual(pages(tasks, 'man', { name: 'ops tasks' }).map((p) => p.file).slice(0, 2), ['ops-tasks.1', 'ops-tasks-db-migrate.1']);
});

test('--out-dir: lists the files, writes them with --execute, and leaves unchanged ones alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clyops-doc-'));
  try {
    const out = join(dir, 'man1');
    const input = JSON.stringify(tasks);
    const preview = run(['--split', '--out-dir', out, '--date', '2026-10-21'], input);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.stdout, ['tasks.1', 'tasks-db-migrate.1', 'tasks-db-status.1', 'tasks-send.1'].map((f) => join(out, f) + '\n').join(''));
    assert.match(preview.stderr, /Would write 4 page\(s\) in .*; add --execute to write them\./);
    assert.equal(existsSync(out), false, 'nothing is written without --execute');

    const wrote = run(['--split', '--out-dir', out, '--execute', '--date', '2026-10-21'], input);
    assert.equal(wrote.status, 0, wrote.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['tasks-db-migrate.1', 'tasks-db-status.1', 'tasks-send.1', 'tasks.1']);
    assert.equal(readFileSync(join(out, 'tasks-send.1'), 'utf8'), pages(tasks, 'man', { date: '2026-10-21' })[3].content);

    const mtime = statSync(join(out, 'tasks.1')).mtimeMs;
    writeFileSync(join(out, 'tasks-send.1'), 'old\n');
    const again = run(['--split', '--out-dir', out, '-x', '--date', '2026-10-21'], input);
    assert.match(again.stderr, /Wrote 1 page\(s\) \(replacing 1\); 3 already up to date in /);
    assert.equal(statSync(join(out, 'tasks.1')).mtimeMs, mtime, 'an unchanged page is not rewritten');
    assert.notEqual(readFileSync(join(out, 'tasks-send.1'), 'utf8'), 'old\n');

    const single = run(['--out-dir', dir, '-x', '--format', 'markdown'], JSON.stringify(demo));
    assert.equal(single.status, 0, single.stderr);
    assert.equal(single.stdout, join(dir, 'demo.md') + '\n');
    assert.match(readFileSync(join(dir, 'demo.md'), 'utf8'), /^<!-- Generated by clyops-doc from --help-json-schema\. Do not edit; regenerate instead\. -->\n\n# `demo`\n/);

    for (const flag of ['split', 'execute']) {
      const bad = run([`--${flag}`], input);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, new RegExp(`--${flag} needs --out-dir or --prefix`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--root: a page per tool and an index, found the way the dispatcher finds them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clyops-doc-'));
  try {
    const tools = join(dir, 'tools');
    mkdirSync(join(tools, 'db'), { recursive: true });
    writeFileSync(join(tools, '.clyops'), 'description: Operations tools. Run them as ops TOOL.\n');
    // A quoted heredoc keeps the schema's own quotes as they are.
    const tool = (file, schema) => { writeFileSync(file, `#!/bin/sh\n# clyops-tool\n[ "$1" = --help-json-schema ] && cat <<'SCHEMA'\n${JSON.stringify(schema)}\nSCHEMA\n`); chmodSync(file, 0o755); };
    tool(join(tools, 'send.sh'), { ...demo, script: 'send', description: 'Send a message.' });
    tool(join(tools, 'db', 'tasks'), tasks);
    writeFileSync(join(tools, 'notes.sh'), '#!/bin/sh\necho not a clyops tool\n');
    chmodSync(join(tools, 'notes.sh'), 0o755);
    writeFileSync(join(tools, 'broken.sh'), '#!/bin/sh\n# clyops-tool\nexit 3\n');
    chmodSync(join(tools, 'broken.sh'), 0o755);

    const out = join(dir, 'man');
    const listed = run(['--root', tools, '--name', 'ops', '--out-dir', out, '--date', '2026-10-21']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n').map((p) => p.slice(out.length + 1)), ['ops.1', 'ops-send.1', 'ops-db-tasks.1']);
    assert.match(listed.stderr, /Skipping .*notes\.sh: not a clyops tool/);
    assert.match(listed.stderr, /Skipping .*broken\.sh/);

    const split = run(['--root', tools, '--name', 'ops', '--out-dir', out, '--split', '-x', '--date', '2026-10-21']);
    assert.equal(split.status, 0, split.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['ops-db-tasks-db-migrate.1', 'ops-db-tasks-db-status.1', 'ops-db-tasks-send.1', 'ops-db-tasks.1', 'ops-send.1', 'ops.1']);
    const index = readFileSync(join(out, 'ops.1'), 'utf8');
    assert.match(index, /^\.SH "NAME"\nops \\- Operations tools$/m);
    assert.match(index, /^ops send \[ARGUMENTS\] \[OPTIONS\]\nops db tasks \[ARGUMENTS\] \[OPTIONS\]$/m);
    assert.match(index, /^\\fBops db tasks\\fR\nCommands demo for the clyops conformance suite\. See ops\\-db\\-tasks\(1\)\.$/m);
    assert.match(readFileSync(join(out, 'ops-db-tasks-db-migrate.1'), 'utf8'), /^ops db tasks db migrate \[<target>\] \[OPTIONS\]$/m);
    assert.match(readFileSync(join(out, 'ops-send.1'), 'utf8'), /^\.SH "NAME"\nops\\-send \\- Send a message$/m);
    if (hasGroff) for (const f of readdirSync(out)) assert.equal(groffWarnings(readFileSync(join(out, f), 'utf8')), '', f);

    const prefix = join(dir, 'prefix');
    const installed = run(['--root', tools, '--name', 'ops', '--prefix', prefix, '-x', '--section', '8'], undefined, { MANPATH: '/nowhere' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(existsSync(join(prefix, 'share/man/man8/ops.8')));
    // manpath(1) honours MANPATH, and without manpath clyops-doc reads MANPATH itself.
    assert.match(installed.stderr, /man won't find these pages: .*share\/man is not on its search path/);
    const found = run(['--root', tools, '--name', 'ops', '--prefix', prefix, '--section', '8'], undefined, { MANPATH: join(prefix, 'share/man'), PATH: '/usr/bin:/bin' });
    assert.equal(found.status, 0, found.stderr);
    assert.doesNotMatch(found.stderr, /man won't find/);
    assert.equal(run(['--root', tools, '--prefix', prefix, '--format', 'html']).status, 1);
    assert.match(run(['--root', tools]).stderr, /--root needs --out-dir or --prefix/);
    assert.match(run(['--root', join(dir, 'man'), '--out-dir', out]).stderr, /no clyops tools in /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

