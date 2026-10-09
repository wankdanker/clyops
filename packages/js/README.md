# clyops (JavaScript / TypeScript)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. Written in TypeScript; ships CommonJS, ESM and type declarations. No runtime
dependencies, Node 20+. See the [main README](https://github.com/wankdanker/clyops).

```js
#!/usr/bin/env node
const { Cli, info } = require('clyops');   // or: import { Cli, info } from 'clyops';

const cli = new Cli();
cli.setDescription('Copy files to a server.');
cli.arg('SRC', 'File to send', '', 'file:exists');
cli.argVariadic('EXTRA', 'More files', 'file:exists');
cli.opt('HOST', 'host', 'H', 'localhost', 'Server', 'Network', 'hostname');
cli.opt('PORT', 'port', 'p', '22', 'Port', 'Network', 'port');
cli.opt('VERBOSE', 'verbose', 'v', 'flag', 'Chatty');
cli.opt('CONFIG', 'config', 'c', 'optional', 'Config file', 'Config', 'path');
cli.setConfig('config', 'send:');
const args = cli.run();

info('sending %s to %s:%d', args.SRC, args.HOST, args.PORT);
```

Registration is `opt`, `optArray`, `arg` and `argVariadic` (`getOpt`, `getOptArray`, `getArg` and
`getArgVariadic` remain as deprecated aliases). `run()` handles `--help`, `--help-json-schema`, `--completion <shell>` and errors (exiting the
process). `parse()` does the same work without exiting and returns `{ status: 'ok' | 'help' | 'error' }`.
Values are typed: `PORT` is a number, flags are booleans, array options and variadics are arrays.

Other API: `source(long)`, `isSet(long)`, `isExplicitlySet(long)`, `usage()`, `jsonSchema()`,
`completionScript(shell)`, `valuesJson()`, `setPathSearch(long, dirs)`, `requireCommand(cmd, desc, hint)`,
and the logging helpers `info`, `warn`, `error`, `success`, `die`.

## Commands, relationships, secrets, effects and I/O

```js
const db = cli.command('db', 'Database tasks');              // a command: mytool db ...
const migrate = db.command('migrate', 'Apply migrations');   // mytool db migrate
migrate.opt('TO', 'to', '', 'optional', 'Target version', 'Options', 'int');
migrate.setEffects('destructive');                           // read-only, idempotent, destructive, network
cli.opt('TOKEN', 'token', 't', '', 'API token', 'Auth', 'secret');  // masked in help and valuesJson()
cli.exclusive('json', 'quiet');                              // also requires(a, b...) and oneOf(a, b...)
cli.setStdin('Audio to transcribe', 'audio/wav');            // and setStdout(description, contentType)
const args = cli.run();                                      // args.command: ['db', 'migrate']
```

`cli.commandPath` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.
