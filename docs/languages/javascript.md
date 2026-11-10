---
title: JavaScript / TypeScript
---
# JavaScript / TypeScript

Requires **Node 20+**. [Complete API reference](/reference/node/index.html) · [Shared behavior](../guide.md)

## Install and run

```sh
pnpm add clyops
```

Save the following as `quickstart.cjs`:

<!-- example: quickstart.cjs -->
```javascript
const { Cli } = require('clyops');
const cli = new Cli({ name: 'docs-demo' });
cli.opt('NAME', 'name', 'n', 'World', 'Who to greet');
cli.opt('COUNT', 'count', 'c', '1', 'Repeat count', 'Options', 'int:1-3');
cli.opt('VERBOSE', 'verbose', 'v', 'flag', 'Verbose output');
const args = cli.run();
console.log(`${args.NAME} ${args.COUNT} ${args.VERBOSE}`);
```

```sh
node quickstart.cjs --name Ada --count 2 --verbose
# Ada 2 true
node quickstart.cjs --help
node quickstart.cjs --help-json-schema
node quickstart.cjs --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

VS Code and WebStorm read the packaged declarations and documentation comments. Declaration maps link definitions to the TypeScript sources included in each package. Both ESM and CommonJS package entrypoints expose the same declarations. The copied standalone `.cjs` file is a runtime artifact; keep the package declarations available if you also want editor types.

TypeScript uses the same package:

<!-- example: quickstart.ts -->
```typescript
import { Cli } from 'clyops';
const cli = new Cli({ name: 'docs-demo' });
cli.opt('NAME', 'name', 'n', 'World', 'Who to greet');
cli.opt('COUNT', 'count', 'c', '1', 'Repeat count', 'Options', 'int:1-3');
cli.opt('VERBOSE', 'verbose', 'v', 'flag', 'Verbose output');
const args = cli.run();
// Runtime registrations return a union; narrow before doing numeric work.
if (typeof args.COUNT !== 'number') throw new Error('Expected a number');
console.log(`${args.NAME} ${args.COUNT} ${args.VERBOSE}`);
```

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```js
const db = cli.command('db', 'Database tasks');              // a command: mytool db ...
const migrate = db.command('migrate', 'Apply migrations');   // mytool db migrate
migrate.opt('TO', 'to', '', 'optional', 'Target version', 'Options', 'int');
migrate.setEffects('destructive');                           // read-only, idempotent, destructive, network
cli.opt('TOKEN', 'token', 't', '', 'API token', 'Auth', 'secret');  // masked in help and valuesJson()
cli.opt('JSON', 'json', '', 'flag', 'JSON output');
cli.opt('QUIET', 'quiet', '', 'flag', 'Quiet output');
cli.exclusive('json', 'quiet');                              // also requires(a, b...) and oneOf(a, b...)
cli.setStdin('Audio to transcribe', 'audio/wav');            // and setStdout(description, contentType)
cli.role('progress', 'out', 'Progress', 'application/x-ndjson');  // then cli.emit('progress', { pct: 50 })
const args = cli.run();                                      // args.command: ['db', 'migrate']
```

`cli.commandPath` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Completion values from your program

`complete(name, fn)` lists an option's or argument's values for values only the
program can find, such as the instances registered in a directory. Shells offer
them on Tab, and the API, MCP server and web runner list them on demand
(`--complete-values`). The function gets a request, `{ words, prefix, limit, offset }`,
where `words` are the words typed after the command words:

```js
const fs = require('node:fs');
cli.opt('INSTANCE', 'instance', 'i', '', 'Instance to target');
cli.complete('instance', () => fs.readdirSync('/var/lib/myapp/instances').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
```

By default the function may return everything: the library keeps the values that
start with `prefix` and pages them. For thousands of values, register it
`{ paged: true }` and apply the prefix, offset and limit yourself:

```js
cli.complete('customer', ({ prefix, limit, offset }) => db.prepare('SELECT DISTINCT name FROM customers WHERE name LIKE ? ORDER BY name LIMIT ? OFFSET ?').all(prefix + '%', limit || -1, offset).map((r) => r.name), { paged: true });
```

The function runs only when values are asked for, on every Tab, so keep it quick
and read-only. Throwing keeps the rule's shell completion. It doesn't validate:
check the value after `run` if only listed values are allowed.
`cli.completeValues(name, prefix, limit, offset, words)` returns a page,
`{ values, more }`. See the [spec](../../spec/SPEC.md) sections 9.2 and 9.3.

## Parsing and errors

Use `run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
