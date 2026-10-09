// The conformance demo CLI in TypeScript, importing the published package
// entry point so the shipped type declarations are exercised too.
import { Cli } from 'clyops';

const cli = new Cli({ name: 'demo', root: process.env.DEMO_ROOT });
cli.setDescription('Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values.');
cli.setEpilog('Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf');
cli.requireCommand('sh', 'POSIX shell', 'install dash');
cli.setEffects('idempotent', 'network');
cli.setStdin('Lines to process', 'text/plain');
cli.setStdout('The resolved values', 'application/json');

cli.arg('input', 'Input file', '', 'path');
cli.arg('mode', 'Processing mode', 'fast', 'choice:fast,slow');
cli.argVariadic('rest', 'Extra items');

cli.opt('CONFIG',   'config',   'c', 'optional',  'Config file to load',   'Config',     'path');
cli.opt('VERBOSE',  'verbose',  'v', 'flag',      'Enable verbose output', 'Output');
cli.opt('QUIET',    'quiet',    'q', 'flag',      'Suppress output',       'Output');
cli.opt('COLOR',    'color',    '',  'auto',      'When to use color',     'Output',     'choice:auto,always,never');
cli.opt('OUT',      'out',      'o', 'out.txt',   'Output path',           'Output',     'path');
cli.opt('NOTES',    'notes',    '',  'optional',  'Free-form notes. This description is deliberately long so that the help output has to wrap it onto several lines at the default width of one hundred columns.', 'Output');
cli.opt('COUNT',    'count',    'n', '3',         'Number of iterations',  'Options',    'int:1-10');
cli.opt('RATIO',    'ratio',    '',  '0.5',       'Mix ratio',             'Options',    'float:0-1');
cli.opt('ENABLED',  'enabled',  '',  'true',      'Enable processing',     'Options',    'bool');
cli.optArray('TAG', 'tag',      't',              'Tag to attach',         'Options',    'string:1-8');
cli.opt('NO_CACHE', 'no-cache', '',  'flag',      'Disable the cache',     'Options');
cli.opt('KEY',      'key',      'k', '',          'API key',               'Auth',       'secret');
cli.opt('HOST',     'host',     'H', 'localhost', 'Server host',           'Network',    'hostname');
cli.opt('PORT',     'port',     'p', '8080',      'Server port',           'Network',    'port');
cli.opt('ENDPOINT', 'endpoint', '',  'optional',  'Endpoint URL',          'Network',    'url');
cli.opt('ADDR',     'addr',     '',  'optional',  'Bind address',          'Network',    'ip');
cli.opt('ID',       'id',       '',  'optional',  'Request identifier',    'Validation', 'uuid');
cli.opt('EMAIL',    'email',    '',  'optional',  'Contact email',         'Validation', 'email');
cli.opt('DATE',     'date',     '',  'optional',  'Start date',            'Validation', 'date:YYYY-MM-DD');
cli.opt('CODE',     'code',     '',  'optional',  'Three-letter code',     'Validation', 'regex:^[A-Z]{3}$');
cli.opt('LEVEL',    'level',    '',  'optional',  'Level',                 'Validation', 'int');
cli.opt('SIZE',     'size',     '',  'optional',  'Size code',             'Validation', 'string:4');
cli.opt('DATA_DIR', 'data-dir', 'd', 'optional',  'Data directory',        'Files',      'dir:exists');
cli.opt('SRC',      'src',      '',  'optional',  'Source file',           'Files',      'file:exists');
cli.opt('DEST',     'dest',     '',  'optional',  'Destination file',      'Files',      'file:writable');
cli.optArray('INCLUDE', 'include', 'I',           'Include directory',     'Files',      'path');

cli.setConfig('config', 'demo:,shared:');
cli.setPathSearch('config', 'conf');
cli.exclusive('endpoint', 'addr');
cli.requires('dest', 'src');

cli.run();

const longs = ['config', 'verbose', 'quiet', 'color', 'out', 'notes', 'count', 'ratio', 'enabled', 'tag', 'no-cache', 'key',
  'host', 'port', 'endpoint', 'addr', 'id', 'email', 'date', 'code', 'level', 'size', 'data-dir', 'src', 'dest', 'include', 'help'];
const sources = Object.fromEntries(longs.map((l) => [l, cli.source(l)] as const));
process.stdout.write(JSON.stringify({ values: JSON.parse(cli.valuesJson()), sources }, null, 2) + '\n');
