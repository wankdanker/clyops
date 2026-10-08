# clyops (JavaScript / TypeScript)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. Written in TypeScript; ships CommonJS, ESM and type declarations. No runtime
dependencies, Node 18+. See the [main README](https://github.com/wankdanker/clyops).

```js
#!/usr/bin/env node
const { Cli, info } = require('clyops');   // or: import { Cli, info } from 'clyops';

const cli = new Cli();
cli.setDescription('Copy files to a server.');
cli.getArg('SRC', 'File to send', '', 'file:exists');
cli.getArgVariadic('EXTRA', 'More files', 'file:exists');
cli.getOpt('HOST', 'host', 'H', 'localhost', 'Server', 'Network', 'hostname');
cli.getOpt('PORT', 'port', 'p', '22', 'Port', 'Network', 'port');
cli.getOpt('VERBOSE', 'verbose', 'v', 'flag', 'Chatty');
cli.getOpt('CONFIG', 'config', 'c', 'optional', 'Config file', 'Config', 'path');
cli.setConfig('config', 'send:');
const args = cli.run();

info('sending %s to %s:%d', args.SRC, args.HOST, args.PORT);
```

`run()` handles `--help`, `--help-json-schema`, `--completion <shell>` and errors (exiting the
process). `parse()` does the same work without exiting and returns `{ status: 'ok' | 'help' | 'error' }`.
Values are typed: `PORT` is a number, flags are booleans, array options and variadics are arrays.

Other API: `source(long)`, `isSet(long)`, `isExplicitlySet(long)`, `usage()`, `jsonSchema()`,
`completionScript(shell)`, `valuesJson()`, `setPathSearch(long, dirs)`, `requireCommand(cmd, desc, hint)`,
and the logging helpers `info`, `warn`, `error`, `success`, `die`.
