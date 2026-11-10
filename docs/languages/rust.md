---
title: Rust
---
# Rust

Requires **Rust 1.70+**. [Complete API reference](/reference/rust/clyops/index.html) · [Shared behavior](../guide.md)

## Install and run

```sh
cargo add clyops
```

Save this as `src/main.rs` in a Cargo application.

Save the following as `quickstart.rs`:

<!-- example: quickstart.rs -->
```rust
use clyops::Cli;

fn main() {
    let mut cli = Cli::new();
    cli.name("docs-demo");
    cli.opt("NAME", "name", "n", "World", "Who to greet");
    cli.opt("COUNT", "count", "c", "1", "Repeat count").rule("int:1-3");
    cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output");
    let args = cli.run();
    println!("{} {} {}", args.str("NAME"), args.int("COUNT"), args.bool("VERBOSE"));
}
```

```sh
cargo run -- --name Ada --count 2 --verbose
# Ada 2 true
cargo run -- --help
cargo run -- --help-json-schema
cargo run -- --count invalid
# Validation error; exit status 1
```

## Editor support and resolved values

rust-analyzer reads the native signatures and rustdoc comments. `cargo doc --open` builds the local reference. Values have a tagged `Value` enum and typed getters; there is no inferred application-specific struct.

## Commands, relationships, secrets, effects and I/O

Add these registrations before calling `run`. A CLI level has either subcommands or positional arguments.

```rust
let db = cli.command("db", "Database tasks");              // a command: mytool db ...
let migrate = db.command("migrate", "Apply migrations");   // mytool db migrate
migrate.opt("TO", "to", "", "optional", "Target version").rule("int");
migrate.effects(&["destructive"]);                         // read-only, idempotent, destructive, network
cli.opt("TOKEN", "token", "t", "", "API token").group("Auth").rule("secret"); // masked in help and values_json()
cli.exclusive(&["json", "quiet"]);                         // also requires("a", &["b"]) and one_of(&[...])
cli.stdin("Audio to transcribe", "audio/wav");             // and stdout(description, content_type)
cli.role("progress", "out", "Progress", "application/x-ndjson");    // then cli.emit("progress", r#"{"pct":50}"#)
let args = cli.run();                                      // args.strs("command") == ["db", "migrate"]
```

`cli.command_path()` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Completion values from your program

`complete(name, fn)` lists the values of an option or argument, read when the
user presses Tab and by tooling (`--complete-values`), for values only the
program can find, such as the instances registered in a directory:

```rust
cli.opt("INSTANCE", "instance", "i", "", "Instance to target");
cli.complete("instance", |_request| {
    let names = std::fs::read_dir("/var/lib/myapp/instances")?.filter_map(|e| e.ok()?.file_name().into_string().ok());
    Ok(names.filter_map(|n| n.strip_suffix(".json").map(String::from)).collect())
});
```

The closure (`Fn(&CompleteRequest) -> CompleteResult`, where `CompleteResult` is
`Result<Vec<String>, Box<dyn Error>>`) runs only for `--bash-completion` and
`--complete-values`, so keep it quick. The `CompleteRequest` carries `words`
(the words typed after the command words, for completers that depend on another
option), `prefix`, `limit` and `offset`. The library keeps the values that start
with `prefix` and pages them, so a completer can ignore those and return every
value. Returning an error, or panicking, keeps the rule's completion. It doesn't
validate: check the value after `run` if only listed values are allowed.

For a long list, register with `complete_paged` and apply the prefix, offset and
limit yourself, for example in a query. `limit` is one more than the page (so
the library can tell whether more remain) and `0` means no limit; the library
only truncates:

```rust
cli.complete_paged("customer", |req| {
    // SELECT name FROM customers WHERE name LIKE :prefix || '%' ORDER BY name LIMIT :limit OFFSET :offset
    // (no LIMIT when req.limit is 0)
    let names: Vec<String> = query_customers(&req.prefix, req.limit, req.offset)?;
    Ok(names)
});
```

`cli.complete_values(name, prefix, limit, offset, &words)` returns a
`ValuesPage { values, more }`, and `mytool --complete-values NAME PREFIX LIMIT
OFFSET -- WORDS...` prints it as JSON for the HTTP API, MCP server and web
runner. See the [spec](../../spec/SPEC.md) sections 9.2 and 9.3.

## Parsing and errors

Use `run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
