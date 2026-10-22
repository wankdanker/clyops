---
title: Dispatcher and desktop runner
---
# Dispatcher and desktop runner

## Dispatcher

`clyops-dispatch` turns a directory into nested subcommands. Download a binary
from the [release](https://github.com/wankdanker/clyops/releases), then:

```sh
clyops-dispatch --root ./tools --name mytools --help
clyops-dispatch --root ./tools --name mytools media convert --help
```

A `.clyops` file controls descriptions, directories, ignored entries and allowed
or denied tools. Source detection requires a supported import/source statement
or an explicit `# clyops-tool` / `// clyops-tool` header marker for wrappers.
Binary completion markers and nested dispatcher shebangs are also supported.
Schemas are cached by file stamp; probes have a timeout.

The [dispatcher guide](../apps/dispatch/README.md) covers definition files,
aliases, completion, caching and filesystem behavior. This application exposes
a command-line interface, rather than an installed library API.

## Desktop runner

The runner lists tools and generates forms from their schemas, including commands,
secrets, constraints, effect badges and declared stdin/stdout. Unchecked flags
explicitly override enabled config/environment values. Templates preserve false
and zero values and omit secrets. Destructive tools require confirmation. A tool's
`progress` role shows as a progress bar, its `meta` beside the output, and `log`
and `result` lines in it.

See the [runner guide](../apps/runner/README.md) for installation, usage, templates
and frontend/native development. Its internal UI helpers are not a public package API.

## Documentation (clyops-doc)

`clyops-doc` reads a tool's `--help-json-schema` and writes a man page, Markdown or HTML, so any
clyops tool gets documentation without writing it twice:

```sh
mytool --help-json-schema | clyops-doc > mytool.1
mytool --help-json-schema | clyops-doc --format markdown --name "mytool media to-pcm" > to-pcm.md
```

A program with commands gets a section per command with the options it inherits. To write files
instead, give `--out-dir` (or `--prefix` to install man pages where `man` looks), and `--execute`
to actually write them; without it, clyops-doc only lists the files:

```sh
mytool --help-json-schema | clyops-doc --split --out-dir man1 --execute    # mytool.1, mytool-db-migrate.1, ...
clyops-doc --root ./tools --name mytools --prefix ~/.local --execute       # every tool, and an index page
```

`--split` gives each command a page of its own, git-style, and `--root` documents a whole directory
of tools the way the dispatcher finds them. The [clyops-doc guide](../apps/doc/README.md) covers
the options and what goes in each section; [spec section 15](../spec/SPEC.md#15-documentation-clyops-doc)
is the contract.

## Web runner

The static SvelteKit web runner is served by `clyops-api` at `/ui/`. It discovers
tools through REST and uses the shared schema package for typed fields, ranges,
relationship hints and secret handling. See the [web runner guide](web-runner.md).
