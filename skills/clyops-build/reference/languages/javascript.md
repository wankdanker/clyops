# clyops in JavaScript / TypeScript

Node 20+. ESM and CommonJS entry points with bundled type declarations.

## Install

```sh
pnpm add clyops        # or npm install clyops
```

A `require`/`import` of `clyops` (or of a local `clyops.cjs`, `.js`, `.mjs`,
`.ts`) is what makes the dispatcher, API and MCP server recognize the tool.

## Registration

```js
const { Cli, info, die } = require('clyops');   // or: import { Cli, info, die } from 'clyops';

const cli = new Cli({ name: 'plan' });          // also root: ...
cli.opt(VAR, long, short, defaultValue, description, group, rule);
cli.optArray(VAR, long, short, description, group, rule);
cli.arg(NAME, description, defaultValue, rule);
cli.argVariadic(NAME, description, rule);
```

Trailing `group` and `rule` are optional. Metadata: `setDescription`,
`setEpilog`, `setConfig(option, prefixes)`, `setPathSearch(long, dirs)`,
`requireCommand(cmd, description, hint)`, `setEffects(...effects)`,
`setStdin(description, contentType)`, `setStdout(description, contentType)`,
`exclusive(...longs)`, `requires(...longs)`, `oneOf(...longs)`,
`command(name, description)`.

## Values

`const args = cli.run()` returns an object keyed by variable/argument name.
Values are typed (`int*`/`port` numbers, flags/`bool` booleans, arrays,
`null` when unset). `args.command` (or `cli.commandPath`) is the selected
command words. In TypeScript values are a union type: narrow before numeric
work (`if (typeof args.COUNT !== 'number') throw …`).

Also `cli.source(long)`, `cli.valuesJson()`, and non-exiting
`cli.parse(argv)` → `{ status: 'ok' | 'help' | 'error', error? }`.

## Logging

`info`, `warn`, `error`, `success` accept printf-style formats
(`info('sent %s', name)`); `die(code, format, ...args)` logs and exits.

## Example

```js
#!/usr/bin/env node
'use strict';
const { Cli } = require('clyops');

const cli = new Cli({ name: 'plan' });
cli.setDescription('Build a deployment plan. Change nothing.');
cli.opt('SERVICE', 'service', 's', 'api', 'Service', 'Options', 'choice:api,worker');
cli.opt('ENV', 'env', 'e', 'staging', 'Environment', 'Options', 'choice:staging,production');
cli.opt('REPLICAS', 'replicas', 'r', '2', 'Replica count', 'Options', 'int:1-10');
cli.optArray('TAG', 'tag', 't', 'Labels to attach', 'Options', 'string:1-40');
cli.opt('WEBHOOK', 'webhook', '', 'optional', 'Notify this webhook', 'Notification', 'url');
cli.opt('EMAIL', 'email', '', 'optional', 'Notify this email address', 'Notification', 'email');
cli.exclusive('webhook', 'email');
cli.setEffects('read-only');
cli.setStdout('Deployment plan', 'application/json');
const args = cli.run();

// Our tool's logic starts here, after the interface is fully declared.
console.log(JSON.stringify({ service: args.SERVICE, env: args.ENV, replicas: args.REPLICAS, tags: args.TAG }));
```

## Commands

```js
cli.opt('VERBOSE', 'verbose', 'v', 'flag', 'Verbose output', 'Global');   // program options first
const db = cli.command('db', 'Database tasks');
db.opt('DB_URL', 'url', 'u', 'sqlite:app.db', 'Database URL', 'Database');
const migrate = db.command('migrate', 'Apply migrations');
migrate.arg('target', 'Target version', 'latest');
migrate.opt('DRY_RUN', 'dry-run', 'n', 'flag', 'Show what would run');
migrate.setEffects('destructive');
db.command('status', 'Show migration status').setEffects('read-only');
const args = cli.run();
if (args.command.join(' ') === 'db migrate') { /* ... */ }
```
