# clyops-schema

Browser-compatible types and helpers for the clyops tool contract. The API, MCP
server, desktop runner and web runner share this conversion rather than maintaining
separate interpretations. This package has no runtime dependencies or Node imports.

```sh
pnpm add clyops-schema
```

```ts
import { toJsonSchema, formFields, constraintIssues, withoutSecrets } from 'clyops-schema';
import type { Schema } from 'clyops-schema';

const tool: Schema = await fetch('/tools/plan').then(r => r.json()).then(r => r.schema);
const inputSchema = toJsonSchema(tool);
const fields = formFields(tool);
const input = { replicas: 2 };
const relationships = constraintIssues(tool, input);
const template = withoutSecrets(tool, input);
```

`toJsonSchema` describes submitted input: choices become enums; numeric and string
bounds, typed arrays, positional arguments and secret markers are preserved.
`formFields` adds groups, paths, required/inherited hints and the same value schema.
`formSchema` attaches constraints, effects and I/O as `x-clyops` metadata.
`inputKey`, `inputKeys` and `isBareFlag` retain the mapping used by clyops-tools.
`isTextType` classifies declared streams.
`checkableInputSchema(inputSchema, compile, onError)` leaves a `json` input unchecked when
its schema doesn't compile with your validator (e.g. ajv's), reporting each one.

Defaults are descriptions, not instructions to fill and submit every field.
Required options, `requires`, and clyops `oneOf` can be satisfied by the tool's
config or environment. `constraintIssues` reports unresolved requirements as
notices and explicit exclusivity conflicts as errors. The actual tool validates
effective values after resolving all sources. clyops `oneOf` means at least one,
not JSON Schema's exactly-one keyword. Defaults never count as given.

The optional `naming: 'declared'` argument on conversion/form helpers retains
original names for desktop templates. The default uses normalized API/MCP keys.
Secrets are excluded from schema defaults and `withoutSecrets` filters them and
undeclared keys from templates and previews; explicit false and zero survive.

Read the [web runner and shared-schema guide](https://clyops.io/web-runner.html)
and [complete API reference](https://clyops.io/reference/node/index.html).
