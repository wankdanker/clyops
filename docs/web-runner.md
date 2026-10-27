---
title: Web runner and shared schema
---
# Web runner and shared schema

The SvelteKit web runner turns the REST API's tool descriptions into forms and
execution results. Its built HTML/CSS/JavaScript are static, packaged with the API,
and served at `/ui/`. It does not need a SvelteKit server at runtime.

## Start and connect

Install `clyops-api` and start it with your executable scripts directory:

```sh
pnpm add clyops-api
pnpm exec clyops-api --root ./scripts --api-key YOUR_KEY
```

Open `http://localhost:8080/ui/`, enter the key, and connect. The UI shell is public
so it can present the login controls; every API tool/job request still requires
the configured key. `--no-ui` disables the bundled frontend independently.
From this repository, `pnpm build` builds the shared package, SPA and API in order;
`node apps/api/dist/cli.js --root ./scripts` starts the built server.

The connection URL is the API root, not its `/ui/` path. Keys stay in memory and
are cleared from the password input after connecting. Disconnect clears the client.
API key scopes continue to determine which tools and jobs are visible.

The default same-origin deployment needs no CORS setup. A frontend served from
another origin requires explicit CORS support in the API's reverse proxy, including
Authorization/Content-Type headers, OPTIONS and GET/POST/DELETE. Use an HTTPS API
when the frontend is HTTPS. The documentation site remains a separate static site;
it does not run the tools or host a REST backend.

## Forms and inheritance

Select a tool from its directory group. Commands appear as separate leaf tools,
with inherited registrations already expanded by the API.

| Declaration | Form control |
| --- | --- |
| `choice:a,b` | Enum dropdown |
| Integer range | Number input with min/max and step 1 |
| Float range | Number input with min/max and arbitrary fractional step |
| String length | Length-aware text input |
| Repeatable option or variadic argument | Repeatable, typed item controls |
| Boolean | Inherit/on/off |
| Secret | Password control, excluded from previews and templates |
| Path | Server path input with optional file upload |
| Declared stdin | Text or file input |
| Declared binary stdout | Authenticated download |

Only enabled overrides are submitted. Declared defaults are hints; they are not
automatically sent. Explicit zero and false are preserved. Untouched values are
resolved by the tool from config, environment and defaults using the usual
[precedence rules](guide.md).

Relationship summaries explain `exclusive`, `requires` and `oneOf`. clyops
`oneOf` means at least one; combine it with `exclusive` for exactly one. Explicit
exclusive conflicts block submission. Requirements that may be satisfied by
config/environment are advisory, and the tool validates effective values.
Destructive tools require confirmation before execution.

A `json` or `json:SCHEMA` field is a text area for its JSON. The text is parsed
and checked against the input's schema as you type, as the API checks it, so
`shape: /w must be integer` or `shape: must be valid JSON` blocks submission
while the field is enabled. "Expected JSON" shows the schema, and an enabled
field starts from the schema's `default`, else its first `examples` entry. The
desktop runner does the same. A URL schema is checked when the API has fetched
it (`--fetch-schemas`, on by default); the desktop runner fetches it itself.

The JSON editor applies the same input schema as the API. It omits secrets;
password values remain in their dedicated controls. Templates save only known,
non-secret overrides in this browser, scoped by API and tool. Files and stdin are
not saved, and restoring a template clears secret fields.

## Execution and jobs

Run synchronously for a result, or submit a background job and follow its status.
The runner polls the existing job endpoints and supports cancellation. A job whose
tool declares a `progress` role shows a progress bar while it runs; output is shown
when the job finishes, with the tool's `meta` beside it. This interface does not
promise live log streaming.
stdout and stderr render ANSI colors (basic, 256-color and truecolor) and styles
by default. Uncheck **ANSI colors** for plain text without escape sequences.
Output remains escaped text; terminal hyperlinks and cursor instructions are
ignored. This is a captured log view rather than an interactive terminal.
Tools must emit ANSI codes; tools that disable color when piped need their own
color option enabled. Downloads preserve original output bytes. Parsed JSON is
displayed as text. Binary envelopes and job
output are downloaded with the API client's bearer key, without putting the key
into a download URL. See [REST endpoints](node-tools.md#http-api).

## Shared library

`clyops-schema` is a dependency-free, browser-compatible package with types,
`toJsonSchema`, `valueSchema`, name mapping, `formFields`, `formSchema`,
`constraintIssues`, `withoutSecrets` and `isTextType`. The
[complete Node API reference](/reference/node/index.html) documents its exports.

```ts
import { toJsonSchema, formFields, constraintIssues } from 'clyops-schema';
const inputSchema = toJsonSchema(toolSchema);
const controls = formFields(toolSchema);
const relationships = constraintIssues(toolSchema, overrides);
```

`toJsonSchema(schema, 'declared')` keeps the original keys for desktop templates;
the default uses the API/MCP input keys. `formSchema` adds clyops metadata without
changing request validation. The API and MCP retain their existing clyops-tools
imports, which re-export the shared converter for compatibility. The desktop
editor now uses it too, and numeric fields share the range conversion.

Build/type/test commands and browser checks are in the [app README](../apps/web/README.md).
