#!/usr/bin/env node
// clyops-api --root DIR: serve a directory of clyops tools over HTTP.
import { Cli, info } from 'clyops';
import { readFileSync } from 'node:fs';
import { createApi } from './server.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const cli = new Cli({ name: 'clyops-api' });
cli.setDescription('Serve a directory of clyops tools as an HTTP API: one POST endpoint per tool, validated and documented (OpenAPI at /openapi.json) from each tool\'s --help-json-schema.');
cli.setEpilog('Every option can also be set in the environment as CLYOPS_API_<OPTION> (CLYOPS_API_API_KEY for the key).\n\nExamples:\n  clyops-api --root ~/mytool/scripts\n  curl -X POST localhost:8080/tools/media/to-pcm -H content-type:application/json -d \'{"input":"a.wav"}\'');
cli.opt('CLYOPS_API_ROOT',         'root',        'r', '',          'Tools directory or dispatcher definition file', 'Tools', 'path');
cli.opt('CLYOPS_API_NAME',         'name',        'n', 'optional',  'API title (default: the directory name)',       'Tools');
cli.opt('CLYOPS_API_CWD',          'cwd',         '',  'optional',  'Working directory for the tools (default: the current one)', 'Tools', 'dir:exists');
cli.opt('CLYOPS_API_TIMEOUT',      'timeout',     't', '0',         'Kill a tool after this many seconds (0: never)', 'Tools', 'int:0-');
cli.opt('CLYOPS_API_CONCURRENCY',  'concurrency', 'j', 'optional',  'Async jobs run at the same time (default: CPUs)', 'Tools', 'int:1-');
cli.opt('CLYOPS_API_HOST',         'host',        'H', '127.0.0.1', 'Address to listen on', 'Server');
cli.opt('CLYOPS_API_PORT',         'port',        'p', '8080',      'Port to listen on',                             'Server', 'port');
cli.opt('CLYOPS_API_API_KEY',      'api-key',     'k', 'optional',  'Require this key (Authorization: Bearer KEY or X-API-Key)', 'Server');
const args = cli.run();

const { app, tools } = await createApi({
  root: args.CLYOPS_API_ROOT as string,
  name: (args.CLYOPS_API_NAME as string | null) ?? undefined,
  cwd: (args.CLYOPS_API_CWD as string | null) ?? undefined,
  timeoutMs: (args.CLYOPS_API_TIMEOUT as number) * 1000,
  concurrency: (args.CLYOPS_API_CONCURRENCY as number | null) ?? undefined,
  apiKey: (args.CLYOPS_API_API_KEY as string | null) ?? undefined,
  version,
});
const server = app.listen(args.CLYOPS_API_PORT as number, args.CLYOPS_API_HOST as string, () => {
  info('serving %d tool(s) on http://%s:%d (OpenAPI: /openapi.json)', tools.length, args.CLYOPS_API_HOST, args.CLYOPS_API_PORT);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
