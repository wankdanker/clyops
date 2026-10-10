import { Cli } from 'clyops';
const cli = new Cli({ name: 'docs-demo' });
cli.opt('NAME', 'name', 'n', 'World', 'Who to greet');
cli.opt('COUNT', 'count', 'c', '1', 'Repeat count', 'Options', 'int:1-3');
cli.opt('VERBOSE', 'verbose', 'v', 'flag', 'Verbose output');
const args = cli.run();
// Runtime registrations return a union; narrow before doing numeric work.
if (typeof args.COUNT !== 'number') throw new Error('Expected a number');
console.log(`${args.NAME} ${args.COUNT} ${args.VERBOSE}`);
