# clyops web runner

A static SvelteKit SPA for the clyops REST API, packaged with `clyops-api` and
served at `/ui/`. It uses `clyops-schema` for the same controls and semantics as
the API and desktop editor.

From the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/api/dist/cli.js --root ./scripts
# Open http://localhost:8080/ui/
```

An installed API exposes the same command as `clyops-api --root ./scripts`.

For frontend development, run the API on port 8080, then use
`pnpm --filter clyops-web dev` and open the printed URL at `/ui/`. The dev server
proxies API requests to `http://127.0.0.1:8080`; keep its own origin in the
connection panel. Set `CLYOPS_DEV_API` to change the proxy target.
A separately hosted production frontend requires the API's reverse
proxy to allow that origin, including Authorization and Content-Type headers,
OPTIONS preflight and GET/POST/DELETE. The default `/ui/` deployment uses the
same origin and needs no CORS configuration.

Supported workflows include grouped/searchable tools, range-aware scalar and
array controls, choices, boolean inheritance, relationship hints, JSON editing,
stdin text/files, path uploads, destructive confirmation, synchronous results,
asynchronous jobs/cancellation, and authenticated binary downloads.
Jobs are polled; output is shown after completion.
stdout and stderr support ANSI colors and styles by default; uncheck **ANSI colors**
for plain text. Downloads preserve the original bytes. Tools that disable colors
when piped need their own color option enabled to emit ANSI codes.

Overrides are explicit. An untouched control does not override config/environment
or defaults. Bearer keys stay in memory and are cleared from the connection input.
Saved templates are local to the browser, scoped by API and tool, and exclude
secrets, files and stdin. The JSON editor omits secrets and preserves values in
their password controls. Output is rendered as escaped text spans, never tool HTML.

```sh
pnpm --filter clyops-web typecheck
pnpm --filter clyops-web test
pnpm --filter clyops-web exec playwright install chromium
pnpm test:web
```

For an installed Chrome, use `PLAYWRIGHT_CHANNEL=chrome pnpm test:web`.
Browser tests start an authenticated API with real tools, exercise forms and
execution, and stop the server when done. The private app is built and copied into
the API package; it is not published separately to npm.
