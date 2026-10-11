// This file is checked against packed packages in an isolated consumer.
import { Cli, type Value } from 'clyops';
import { run, toArgv, type Schema } from 'clyops-tools';
import { JobQueue } from 'clyops-jobs';
import { createApi } from 'clyops-api';
import { createMcpServer } from 'clyops-mcp';
import { formFields, constraintIssues, toJsonSchema } from 'clyops-schema';

const cli = new Cli({ name: 'consumer' });
cli.opt('COUNT', 'count', 'c', '1', 'Count', 'Options', 'int');
const value: Value = cli.run([]).COUNT;
if (typeof value === 'number') value.toFixed();
const schema: Schema = JSON.parse(cli.jsonSchema());
formFields(schema);
constraintIssues(schema, { count: 2 });
toJsonSchema(schema);
toArgv(schema, { count: 2 }, { positionals: 'last' });
run('echo', ['hello'], { timeoutMs: 1000, signal: new AbortController().signal });
const queue = new JobQueue<number>();
const result: Promise<number> = queue.add('test', async () => 42).done;
const api = await createApi({ root: '.', watch: false });
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertTyped<T extends false> = T;
export type HttpApplicationHasTypes = AssertTyped<IsAny<typeof api.app>>;
api.app.listen(0).close();
api.close();
createMcpServer({ name: 'test', tools: [] });
void result;

// Editor declarations must reject invalid callers, not silently widen to any.
// @ts-expect-error The library requires a string validation rule.
cli.opt('COUNT', 'count', 'c', '1', 'Count', 'Options', 123);
// @ts-expect-error Positional order has two supported values.
toArgv(schema, {}, { positionals: 'middle' });
// @ts-expect-error A typed queue preserves the result type.
const wrongResult: Promise<string> = result;
void wrongResult;
