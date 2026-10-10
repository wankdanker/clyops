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
let args = cli.run();                                      // args.strs("command") == ["db", "migrate"]
```

`cli.command_path()` is the selected command words. Commands share the program's options (accepted before or after the command words) and config file;
each has its own help (`mytool db migrate --help`), schema and completion. See the
[spec](../../spec/SPEC.md) sections 1.3 to 1.7.

## Parsing and errors

Use `run` for a standalone program: it displays help/schema/completion and exits for those requests, or exits with status 1 on invalid input. Use the non-exiting `parse` variant in libraries and tests; check its outcome before reading resolved values. Registration errors (duplicate names, unknown rules, or commands mixed with positionals) are programming errors, distinct from invalid user input. See the native reference for the language's result and error types.

## More recipes

[The common guide](../guide.md) covers repeatable options, variadics, validation, config files, paths, secrets, constraints, I/O, completion and provenance. The complete reference above covers each public method and helper, including its native signature. Runnable demo and commands examples also live in the package's `examples` directory.
