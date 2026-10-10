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
and zero values and omit secrets. Destructive tools require confirmation.

See the [runner guide](../apps/runner/README.md) for installation, usage, templates
and frontend/native development. Its internal UI helpers are not a public package API.
