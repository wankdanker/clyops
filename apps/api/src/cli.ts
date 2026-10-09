#!/usr/bin/env node
// clyops-api --root DIR: serve a directory of clyops tools over HTTP.
import { Cli, die, info } from 'clyops';
import { auditLog } from 'clyops-tools';
import { readFileSync } from 'node:fs';
import { createApi, type ApiKey } from './server.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const cli = new Cli({ name: 'clyops-api' });
cli.setDescription('Serve a directory of clyops tools as an HTTP API: one POST endpoint per tool, validated and documented (OpenAPI at /openapi.json) from each tool\'s --help-json-schema.');
cli.setEpilog('Every option can also be set in the environment as CLYOPS_API_<OPTION> (CLYOPS_API_API_KEY for the key).\n\nExamples:\n  clyops-api --root ~/mytool/scripts\n  curl -X POST localhost:8080/tools/media/to-pcm -H content-type:application/json -d \'{"input":"a.wav"}\'');
cli.opt('CLYOPS_API_ROOT',         'root',        'r', '',          'Tools directory or dispatcher definition file', 'Tools', 'path');
cli.opt('CLYOPS_API_NAME',         'name',        'n', 'optional',  'API title (default: the directory name)',       'Tools');
cli.opt('CLYOPS_API_CWD',          'cwd',         '',  'optional',  'Working directory for the tools (default: the current one)', 'Tools', 'dir:exists');
cli.opt('CLYOPS_API_TIMEOUT',      'timeout',     't', '0',         'Kill a tool after this many seconds (0: never)', 'Tools', 'int:0-');
cli.opt('CLYOPS_API_CONCURRENCY',  'concurrency', 'j', 'optional',  'Async jobs run at the same time (default: CPUs)', 'Tools', 'int:1-');
cli.opt('CLYOPS_API_MCP',          'mcp',         '',  'true',      'Also serve the tools over MCP (streamable HTTP) at /mcp', 'Server', 'bool');
cli.opt('CLYOPS_API_WATCH',        'watch',       'w', 'true',      'Pick up added, changed and removed tools without a restart', 'Tools', 'bool');
cli.opt('CLYOPS_API_HOST',         'host',        'H', '127.0.0.1', 'Address to listen on', 'Server');
cli.opt('CLYOPS_API_PORT',         'port',        'p', '8080',      'Port to listen on',                             'Server', 'port');
cli.opt('CLYOPS_API_API_KEY',      'api-key',     'k', 'optional',  'Require this key (Authorization: Bearer KEY or X-API-Key); it may run every tool', 'Server', 'secret');
cli.opt('CLYOPS_API_KEYS',         'keys',        'K', 'optional',  'JSON file of named keys, each with its own scope: {"ci": {"key": "...", "allow": ["media/*"]}}', 'Security', 'file:readable');
cli.optArray('CLYOPS_API_ALLOW',        'allow',        'a',              'Serve only tools matching this glob over their words (media/*, media/**)', 'Security');
cli.optArray('CLYOPS_API_DENY',         'deny',         'D',              'Leave out tools matching this glob', 'Security');
cli.opt('CLYOPS_API_READ_ONLY',         'read-only',    '',  'flag',      'Serve only tools that declare the read-only effect', 'Security');
cli.optArray('CLYOPS_API_PATHS_WITHIN', 'paths-within', '',               'Path inputs must resolve inside this directory', 'Security', 'dir:exists');
cli.opt('CLYOPS_API_MAX_BODY',          'max-body',     '',  '10485760',  'Largest request body in bytes: JSON, multipart or spooled for an async job', 'Security', 'int:1-');
cli.opt('CLYOPS_API_MAX_OUTPUT',        'max-output',   '',  '16777216',  'Keep at most this many bytes of a tool\'s stdout and stderr (0: all)', 'Security', 'int:0-');
cli.opt('CLYOPS_API_AUDIT',             'audit',        '',  'optional',  'Append a JSON line per run to this file (-: stderr)', 'Security', 'path');
const args = cli.run();

let keys: Record<string, ApiKey> | undefined;
if (args.CLYOPS_API_KEYS) {
  try {
    keys = JSON.parse(readFileSync(args.CLYOPS_API_KEYS as string, 'utf8')) as Record<string, ApiKey>;
  } catch (err) {
    die(1, 'cannot read --keys: %s', (err as Error).message);
  }
}
const within = args.CLYOPS_API_PATHS_WITHIN as string[];

const { app, current } = await createApi({
  root: args.CLYOPS_API_ROOT as string,
  name: (args.CLYOPS_API_NAME as string | null) ?? undefined,
  cwd: (args.CLYOPS_API_CWD as string | null) ?? undefined,
  timeoutMs: (args.CLYOPS_API_TIMEOUT as number) * 1000,
  concurrency: (args.CLYOPS_API_CONCURRENCY as number | null) ?? undefined,
  apiKey: (args.CLYOPS_API_API_KEY as string | null) ?? undefined,
  keys,
  filter: { allow: args.CLYOPS_API_ALLOW as string[], deny: args.CLYOPS_API_DENY as string[], readOnly: args.CLYOPS_API_READ_ONLY as boolean },
  within: within.length ? within : undefined,
  maxBody: args.CLYOPS_API_MAX_BODY as number,
  maxOutput: args.CLYOPS_API_MAX_OUTPUT as number,
  audit: args.CLYOPS_API_AUDIT ? auditLog(args.CLYOPS_API_AUDIT as string) : undefined,
  mcp: args.CLYOPS_API_MCP as boolean,
  watch: args.CLYOPS_API_WATCH as boolean,
  onReload: ({ tools }) => info('reloaded: %d tool(s)', tools.length),
  version,
});
const server = app.listen(args.CLYOPS_API_PORT as number, args.CLYOPS_API_HOST as string, () => {
  info('serving %d tool(s) on http://%s:%d (OpenAPI: /openapi.json%s)', current().tools.length, args.CLYOPS_API_HOST, args.CLYOPS_API_PORT, args.CLYOPS_API_MCP ? ', MCP: /mcp' : '');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
