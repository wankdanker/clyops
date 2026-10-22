#!/usr/bin/env node
// clyops-doc: a clyops tool's --help-json-schema on stdin, as a man page, Markdown or HTML.
import { Cli, die, info } from 'clyops';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Schema } from 'clyops-schema';
import { document, extension, pages } from './index.js';
import { defaultDate, pageName } from './model.js';
import type { Format } from './render.js';

const cli = new Cli({ name: 'clyops-doc' });
cli.setDescription('Render a clyops tool\'s --help-json-schema as documentation: a man page, Markdown or HTML. It reads the schema on stdin, so it works with any clyops tool, compiled ones included.');
cli.setEpilog('Examples:\n  mytool --help-json-schema | clyops-doc > mytool.1\n  mytool --help-json-schema | clyops-doc --format markdown > mytool.md\n  clyops-doc --schema schema.json --name "mytool media to-pcm" --format html > to-pcm.html\n  clyops-doc --help-json-schema | clyops-doc | man -l -\n  mytool --help-json-schema | clyops-doc --split --out-dir man1 --execute');
// It writes files only with --out-dir and --execute, and then only its own pages.
cli.setEffects('idempotent', 'destructive');
cli.setStdin('The tool\'s --help-json-schema output (unless --schema is given)', 'application/json');
cli.setStdout('The documentation, in the format --format names; with --out-dir, the files written (or, without --execute, that would be), one per line', 'text/plain');
cli.opt('CLYOPS_DOC_FORMAT',  'format',  'f', 'man',      'Output format',                                                  'Output', 'choice:man,markdown,html');
cli.opt('CLYOPS_DOC_NAME',    'name',    'n', 'optional', 'How the tool is run (default: the schema\'s name), e.g. "mytool media to-pcm"', 'Output');
cli.opt('CLYOPS_DOC_SECTION', 'section', 's', '1',        'Manual section for the man page header',                         'Output', 'regex:^[1-9][a-z]*$');
cli.opt('CLYOPS_DOC_VERSION', 'version', 'V', 'optional', 'Version shown in the header',                                    'Output');
cli.opt('CLYOPS_DOC_DATE',    'date',    'd', 'optional', 'Date shown in the header (default: today, or SOURCE_DATE_EPOCH)', 'Output', 'date:YYYY-MM-DD');
cli.opt('CLYOPS_DOC_SCHEMA',  'schema',  '',  'optional', 'Read the schema from this file instead of stdin',               'Input',  'file:readable');
cli.opt('CLYOPS_DOC_OUT_DIR', 'out-dir', 'o', 'optional', 'Write page files into this directory (created if missing) instead of to stdout', 'Files', 'path');
cli.opt('CLYOPS_DOC_SPLIT',   'split',   '',  'flag',     'A page per command, git-style: mytool.1 lists them, mytool-db-migrate.1 documents one', 'Files');
cli.opt('CLYOPS_DOC_EXECUTE', 'execute', 'x', 'flag',     'Write the files; without it, only list them',                    'Files');
cli.requires('split', 'out-dir');
cli.requires('execute', 'out-dir');
const args = cli.run();

let schema: Schema;
try {
  const text = readFileSync((args.CLYOPS_DOC_SCHEMA as string | null) ?? 0, 'utf8');
  schema = JSON.parse(text) as Schema;
} catch (err) {
  die(1, 'Could not read the schema: %s', (err as Error).message);
}
const format = args.CLYOPS_DOC_FORMAT as Format;
const opts = {
  name: (args.CLYOPS_DOC_NAME as string | null) ?? undefined,
  section: args.CLYOPS_DOC_SECTION as string,
  version: (args.CLYOPS_DOC_VERSION as string | null) ?? undefined,
  date: (args.CLYOPS_DOC_DATE as string | null) ?? defaultDate(),
};
try {
  if (args.CLYOPS_DOC_OUT_DIR !== null) writePages();
  else process.stdout.write(document(schema, format, opts));
} catch (err) {
  die(1, '%s', (err as Error).message);
}

// --out-dir: each page into the directory, leaving files that already say the same alone.
function writePages(): void {
  const dir = args.CLYOPS_DOC_OUT_DIR as string;
  const execute = args.CLYOPS_DOC_EXECUTE as boolean;
  const all = args.CLYOPS_DOC_SPLIT
    ? pages(schema, format, opts)
    : [{ file: `${pageName(opts.name || schema.script)}.${extension(format, opts.section)}`, content: document(schema, format, opts) }];
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
  const counts = `${all.length} page(s)${replaced ? `, replacing ${replaced}` : ''}${unchanged ? `, ${unchanged} already up to date` : ''}`;
  info(execute ? `Wrote ${counts} in ${dir}.` : `Would write ${counts} in ${dir}; add --execute to write them.`);
}
