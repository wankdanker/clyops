// The conformance commands demo in TypeScript.
import { Cli } from 'clyops';

const cli = new Cli({ name: 'tasks', root: process.env.DEMO_ROOT });
cli.setDescription('Commands demo for the clyops conformance suite.');
cli.setEpilog("Run 'tasks <command> --help' for a command's options.");
cli.opt('VERBOSE', 'verbose', 'v', 'flag', 'Verbose output', 'Global');

const db = cli.command('db', 'Database tasks');
db.opt('DB_URL', 'url', 'u', 'sqlite:app.db', 'Database URL', 'Database');
const migrate = db.command('migrate', 'Apply migrations');
migrate.arg('target', 'Target version', 'latest');
migrate.opt('DRY_RUN', 'dry-run', 'n', 'flag', 'Show what would run');
migrate.setEffects('destructive');
const status = db.command('status', 'Show migration status');
status.setEffects('read-only');

const send = cli.command('send', 'Send a message');
send.arg('message', 'Message text');
send.opt('WEBHOOK', 'webhook', 'w', 'optional', 'Webhook URL', 'Options', 'url');
send.opt('EMAIL',   'email',   'e', 'optional', 'Email address', 'Options', 'email');
send.oneOf('webhook', 'email');
send.setEffects('network');
send.setStdin('Attachment', 'application/octet-stream');

cli.run();
process.stdout.write(JSON.stringify({ values: JSON.parse(cli.valuesJson()) }, null, 2) + '\n');
