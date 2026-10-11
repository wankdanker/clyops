#!/usr/bin/env -S pnpm exec tsx
import { Cli } from 'clyops';

const cli = new Cli({ name: 'plan' });
cli.setDescription('Build a deployment plan. Change nothing.');
cli.opt('SERVICE', 'service', 's', 'api', 'Service', 'Options', 'choice:api,worker');
cli.opt('ENV', 'env', 'e', 'staging', 'Environment', 'Options', 'choice:staging,production');
cli.opt('REPLICAS', 'replicas', 'r', '2', 'Replica count', 'Options', 'int:1-10');
cli.setEffects('read-only');
cli.setStdout('Deployment plan', 'application/json');
const args = cli.run();
console.log(JSON.stringify({ service: args.SERVICE, env: args.ENV, replicas: args.REPLICAS }));
