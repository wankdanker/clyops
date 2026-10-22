#!/usr/bin/env node
// clyops-doc: a clyops tool's --help-json-schema on stdin, as a man page, Markdown or HTML.
import { Cli, die, info, warn } from 'clyops';
import { commands, discover, loadSchema } from 'clyops-tools';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { Schema } from 'clyops-schema';
import { document, extension, pages, type Page } from './index.js';
import { defaultDate, firstSentence, pageName, toolsetDoc, type ToolEntry } from './model.js';
import { render, type Format } from './render.js';

const cli = new Cli({ name: 'clyops-doc' });
cli.setDescription('Render a clyops tool\'s --help-json-schema as documentation: a man page, Markdown or HTML. It reads the schema on stdin, so it works with any clyops tool, compiled ones included.');
cli.setEpilog('Examples:\n  mytool --help-json-schema | clyops-doc > mytool.1\n  mytool --help-json-schema | clyops-doc --format markdown > mytool.md\n  clyops-doc --schema schema.json --name "mytool media to-pcm" --format html > to-pcm.html\n  clyops-doc --help-json-schema | clyops-doc | man -l -\n  mytool --help-json-schema | clyops-doc --split --out-dir man1 --execute\n  clyops-doc --root ~/mytool/scripts --name mytool --prefix ~/.local --execute');
// It writes files only with --out-dir or --prefix and --execute, and then only its own pages.
cli.setEffects('idempotent', 'destructive');
cli.setStdin('The tool\'s --help-json-schema output (unless --schema or --root is given)', 'application/json');
// One declared type per program: what it writes is text/troff, text/markdown or text/html by --format.
cli.setStdout('The documentation as --format says: text/troff, text/markdown or text/html; with --out-dir or --prefix, the files written (or, without --execute, that would be), one per line', 'text/plain');
cli.opt('CLYOPS_DOC_FORMAT',  'format',  'f', 'man',      'Output format',                                                  'Output', 'choice:man,markdown,html');
cli.opt('CLYOPS_DOC_NAME',    'name',    'n', 'optional', 'How the tool is run (default: the schema\'s name), e.g. "mytool media to-pcm"; with --root, the dispatcher\'s name (default: the directory\'s)', 'Output');
cli.opt('CLYOPS_DOC_SECTION', 'section', 's', '1',        'Manual section for the man page header',                         'Output', 'regex:^[1-9][a-z]*$');
cli.opt('CLYOPS_DOC_VERSION', 'version', 'V', 'optional', 'Version shown in the header',                                    'Output');
cli.opt('CLYOPS_DOC_DATE',    'date',    'd', 'optional', 'Date shown in the header (default: today, or SOURCE_DATE_EPOCH)', 'Output', 'date:YYYY-MM-DD');
cli.opt('CLYOPS_DOC_SCHEMA',  'schema',  '',  'optional', 'Read the schema from this file instead of stdin',               'Input',  'file:readable');
cli.opt('CLYOPS_DOC_ROOT',    'root',    'r', 'optional', 'Document every tool in this directory (or dispatcher definition), found as clyops-dispatch, clyops-api and clyops-mcp find them, with an index page', 'Input', 'path');
cli.opt('CLYOPS_DOC_OUT_DIR', 'out-dir', 'o', 'optional', 'Write page files into this directory (created if missing) instead of to stdout', 'Files', 'path');
cli.opt('CLYOPS_DOC_PREFIX',  'prefix',  'p', 'optional', 'Install man pages into PREFIX/share/man/manSECTION and check that man finds them', 'Files', 'path');
cli.opt('CLYOPS_DOC_SPLIT',   'split',   '',  'flag',     'A page per command, git-style: mytool.1 lists them, mytool-db-migrate.1 documents one', 'Files');
cli.opt('CLYOPS_DOC_EXECUTE', 'execute', 'x', 'flag',     'Write the files; without it, only list them',                    'Files');
cli.exclusive('schema', 'root');
cli.exclusive('out-dir', 'prefix');
const args = cli.run();

const format = args.CLYOPS_DOC_FORMAT as Format;
const opts = {
  name: (args.CLYOPS_DOC_NAME as string | null) ?? undefined,
  section: args.CLYOPS_DOC_SECTION as string,
  version: (args.CLYOPS_DOC_VERSION as string | null) ?? undefined,
  date: (args.CLYOPS_DOC_DATE as string | null) ?? defaultDate(),
};
const root = args.CLYOPS_DOC_ROOT as string | null;
const prefix = args.CLYOPS_DOC_PREFIX as string | null;
const split = args.CLYOPS_DOC_SPLIT as boolean;
const execute = args.CLYOPS_DOC_EXECUTE as boolean;
const manDir = prefix === null ? null : join(prefix, 'share', 'man');
const outDir = (args.CLYOPS_DOC_OUT_DIR as string | null) ?? (manDir === null ? null : join(manDir, `man${opts.section}`));
if (prefix !== null && format !== 'man') die(1, '--prefix installs man pages; use --out-dir for --format %s', format);
if (outDir === null) {
  // Several pages, or writing them, need somewhere to go.
  const needs = root !== null ? 'root' : split ? 'split' : execute ? 'execute' : null;
  if (needs) die(1, '--%s needs --out-dir or --prefix', needs);
}

try {
  if (root !== null) writePages(await toolsetPages(root));
  else {
    const schema = readSchema();
    if (outDir === null) process.stdout.write(document(schema, format, opts));
    else writePages(split ? pages(schema, format, opts) : [{ file: `${pageName(opts.name || schema.script)}.${extension(format, opts.section)}`, content: document(schema, format, opts) }]);
  }
} catch (err) {
  die(1, '%s', (err as Error).message);
}

function readSchema(): Schema {
  try {
    return JSON.parse(readFileSync((args.CLYOPS_DOC_SCHEMA as string | null) ?? 0, 'utf8')) as Schema;
  } catch (err) {
    return die(1, 'Could not read the schema: %s', (err as Error).message);
  }
}

// --root: a page (or, with --split, pages) per tool, and an index page named after the dispatcher.
async function toolsetPages(dir: string): Promise<Page[]> {
  const group = discover(dir, { name: opts.name });
  const ext = extension(format, opts.section);
  const out: Page[] = [];
  const tools: ToolEntry[] = [];
  for (const cmd of commands(group)) {
    if (cmd.kind !== 'tool') {
      warn('Skipping %s: not a clyops tool', cmd.file);
      continue;
    }
    let schema: Schema;
    try {
      schema = await loadSchema(cmd.file);
    } catch (err) {
      warn('Skipping %s', (err as Error).message);
      continue;
    }
    const name = [group.name, ...cmd.words].join(' ');
    out.push(...(split
      ? pages(schema, format, { ...opts, name })
      : [{ file: `${pageName(name)}.${ext}`, content: document(schema, format, { ...opts, name, page: pageName(name) }) }]));
    tools.push({ words: cmd.words, description: firstSentence(schema.description) });
  }
  if (!tools.length) throw new Error(`no clyops tools in ${dir}`);
  const all = [{ file: `${pageName(group.name)}.${ext}`, content: render(toolsetDoc(group.name, group.description, tools, opts), format) }, ...out];
  const seen = new Set<string>();
  for (const p of all) {
    if (seen.has(p.file)) throw new Error(`two pages would be named ${p.file}`);
    seen.add(p.file);
  }
  return all;
}

// Each page into the directory, leaving files that already say the same alone.
function writePages(all: Page[]): void {
  const dir = outDir as string;
  let replaced = 0;
  let unchanged = 0;
  if (execute) mkdirSync(dir, { recursive: true });
  for (const page of all) {
    const path = join(dir, page.file);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (before === page.content) unchanged++;
    else {
      if (before !== null) replaced++;
      if (execute) writeFileSync(path, page.content);
    }
    process.stdout.write(`${path}\n`);
  }
  const counts = `${all.length - unchanged} page(s)${replaced ? ` (replacing ${replaced})` : ''}${unchanged ? `; ${unchanged} already up to date` : ''}`;
  info(execute ? `Wrote ${counts} in ${dir}.` : `Would write ${counts} in ${dir}; add --execute to write them.`);
  if (manDir !== null) checkManPath(manDir);
}

// --prefix: say so when man won't look in PREFIX/share/man.
function checkManPath(dir: string): void {
  let paths = process.env.MANPATH ?? '';
  try {
    paths = execFileSync('manpath', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    // No manpath(1): MANPATH is all there is to go on.
  }
  const want = resolve(dir);
  if (!paths.split(delimiter).some((p) => p && resolve(p) === want)) {
    warn('man won\'t find these pages: %s is not on its search path. Add it with: export MANPATH="%s%s$(manpath)"', want, want, delimiter);
  }
}
