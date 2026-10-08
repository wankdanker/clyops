#!/usr/bin/env node
// The conformance demo CLI (spec/conformance/README.md), in plain CommonJS.
'use strict';
const { Cli } = require('clyops');

const cli = new Cli({ name: 'demo', root: process.env.DEMO_ROOT });
cli.setDescription('Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values.');
cli.setEpilog('Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf');
cli.requireCommand('sh', 'POSIX shell', 'install dash');

cli.getArg('input', 'Input file', '', 'path');
cli.getArg('mode', 'Processing mode', 'fast', 'choice:fast,slow');
cli.getArgVariadic('rest', 'Extra items');

cli.getOpt('CONFIG',   'config',   'c', 'optional',  'Config file to load',   'Config',     'path');
cli.getOpt('VERBOSE',  'verbose',  'v', 'flag',      'Enable verbose output', 'Output');
cli.getOpt('QUIET',    'quiet',    'q', 'flag',      'Suppress output',       'Output');
cli.getOpt('COLOR',    'color',    '',  'auto',      'When to use color',     'Output',     'choice:auto,always,never');
cli.getOpt('OUT',      'out',      'o', 'out.txt',   'Output path',           'Output',     'path');
cli.getOpt('NOTES',    'notes',    '',  'optional',  'Free-form notes. This description is deliberately long so that the help output has to wrap it onto several lines at the default width of one hundred columns.', 'Output');
cli.getOpt('COUNT',    'count',    'n', '3',         'Number of iterations',  'Options',    'int:1-10');
cli.getOpt('RATIO',    'ratio',    '',  '0.5',       'Mix ratio',             'Options',    'float:0-1');
cli.getOpt('ENABLED',  'enabled',  '',  'true',      'Enable processing',     'Options',    'bool');
cli.getOptArray('TAG', 'tag',      't',              'Tag to attach',         'Options',    'string:1-8');
cli.getOpt('NO_CACHE', 'no-cache', '',  'flag',      'Disable the cache',     'Options');
cli.getOpt('KEY',      'key',      'k', '',          'API key',               'Auth');
cli.getOpt('HOST',     'host',     'H', 'localhost', 'Server host',           'Network',    'hostname');
cli.getOpt('PORT',     'port',     'p', '8080',      'Server port',           'Network',    'port');
cli.getOpt('ENDPOINT', 'endpoint', '',  'optional',  'Endpoint URL',          'Network',    'url');
cli.getOpt('ADDR',     'addr',     '',  'optional',  'Bind address',          'Network',    'ip');
cli.getOpt('ID',       'id',       '',  'optional',  'Request identifier',    'Validation', 'uuid');
cli.getOpt('EMAIL',    'email',    '',  'optional',  'Contact email',         'Validation', 'email');
cli.getOpt('DATE',     'date',     '',  'optional',  'Start date',            'Validation', 'date:YYYY-MM-DD');
cli.getOpt('CODE',     'code',     '',  'optional',  'Three-letter code',     'Validation', 'regex:^[A-Z]{3}$');
cli.getOpt('LEVEL',    'level',    '',  'optional',  'Level',                 'Validation', 'int');
cli.getOpt('SIZE',     'size',     '',  'optional',  'Size code',             'Validation', 'string:4');
cli.getOpt('DATA_DIR', 'data-dir', 'd', 'optional',  'Data directory',        'Files',      'dir:exists');
cli.getOpt('SRC',      'src',      '',  'optional',  'Source file',           'Files',      'file:exists');
cli.getOpt('DEST',     'dest',     '',  'optional',  'Destination file',      'Files',      'file:writable');
cli.getOptArray('INCLUDE', 'include', 'I',           'Include directory',     'Files',      'path');

cli.setConfig('config', 'demo:,shared:');
cli.setPathSearch('config', 'conf');

cli.run();

const longs = ['config', 'verbose', 'quiet', 'color', 'out', 'notes', 'count', 'ratio', 'enabled', 'tag', 'no-cache', 'key',
  'host', 'port', 'endpoint', 'addr', 'id', 'email', 'date', 'code', 'level', 'size', 'data-dir', 'src', 'dest', 'include', 'help'];
const sources = Object.fromEntries(longs.map((l) => [l, cli.source(l)]));
process.stdout.write(JSON.stringify({ values: JSON.parse(cli.valuesJson()), sources }, null, 2) + '\n');
