#!/usr/bin/env node
// clyops-doc: a clyops tool's --help-json-schema on stdin, as a man page, Markdown or HTML.
import { Cli, die } from 'clyops';
import { readFileSync } from 'node:fs';
import type { Schema } from 'clyops-schema';
import { document } from './index.js';
import { defaultDate } from './model.js';
import type { Format } from './render.js';

const cli = new Cli({ name: 'clyops-doc' });
cli.setDescription('Render a clyops tool\'s --help-json-schema as documentation: a man page, Markdown or HTML. It reads the schema on stdin, so it works with any clyops tool, compiled ones included.');
cli.setEpilog('Examples:\n  mytool --help-json-schema | clyops-doc > mytool.1\n  mytool --help-json-schema | clyops-doc --format markdown > mytool.md\n  clyops-doc --schema schema.json --name "mytool media to-pcm" --format html > to-pcm.html\n  clyops-doc --help-json-schema | clyops-doc | man -l -');
cli.setEffects('read-only');
cli.setStdin('The tool\'s --help-json-schema output (unless --schema is given)', 'application/json');
cli.setStdout('The documentation, in the format --format names', 'text/plain');
cli.opt('CLYOPS_DOC_FORMAT',  'format',  'f', 'man',      'Output format',                                                  'Output', 'choice:man,markdown,html');
cli.opt('CLYOPS_DOC_NAME',    'name',    'n', 'optional', 'How the tool is run (default: the schema\'s name), e.g. "mytool media to-pcm"', 'Output');
cli.opt('CLYOPS_DOC_SECTION', 'section', 's', '1',        'Manual section for the man page header',                         'Output', 'regex:^[1-9][a-z]*$');
cli.opt('CLYOPS_DOC_VERSION', 'version', 'V', 'optional', 'Version shown in the header',                                    'Output');
cli.opt('CLYOPS_DOC_DATE',    'date',    'd', 'optional', 'Date shown in the header (default: today, or SOURCE_DATE_EPOCH)', 'Output', 'date:YYYY-MM-DD');
cli.opt('CLYOPS_DOC_SCHEMA',  'schema',  '',  'optional', 'Read the schema from this file instead of stdin',               'Input',  'file:readable');
const args = cli.run();

let schema: Schema;
try {
  const text = readFileSync((args.CLYOPS_DOC_SCHEMA as string | null) ?? 0, 'utf8');
  schema = JSON.parse(text) as Schema;
} catch (err) {
  die(1, 'Could not read the schema: %s', (err as Error).message);
}
try {
  process.stdout.write(document(schema, args.CLYOPS_DOC_FORMAT as Format, {
    name: (args.CLYOPS_DOC_NAME as string | null) ?? undefined,
    section: args.CLYOPS_DOC_SECTION as string,
    version: (args.CLYOPS_DOC_VERSION as string | null) ?? undefined,
    date: (args.CLYOPS_DOC_DATE as string | null) ?? defaultDate(),
  }));
} catch (err) {
  die(1, '%s', (err as Error).message);
}
