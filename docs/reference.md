---
title: API references
---
# API references

The build derives signatures from the code. Public methods, constructors,
helpers, return types and data structures are included. Use the language guide
for recipes and editor setup; use the reference for a specific symbol.

| Guide | Reference | Generator |
| --- | --- | --- |
| [JavaScript / TypeScript](languages/javascript.md) | [Core, tools, jobs, API, MCP](/reference/node/index.html) | TypeDoc |
| [Python](languages/python.md) | [Python API](/reference/python/clyops.html) | pdoc |
| [Rust](languages/rust.md) | [Rust API](/reference/rust/clyops/index.html) | rustdoc |
| [Go](languages/go.md) | [Go API](/reference/go/index.html) | go/doc |
| [Java](languages/java.md) | [Java API](/reference/java/index.html) | Javadoc |
| [Ruby](languages/ruby.md) | [Ruby API](/reference/ruby/index.html) | YARD |
| [C](languages/c.md) | [C API](/reference/c/index.html) | Doxygen |
| [Bash](languages/bash.md) | [Bash API](/reference/bash.html) | Source usage comments |

Reference links above are generated website destinations. On GitHub, read the
package sources or build the site locally using [these instructions](maintaining.md).
Inherited standard-library methods retain their language's semantics; clyops's
dynamic value containers do not declare a different typed property per user option.
