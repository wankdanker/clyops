# clyops in Rust

Rust 1.70+. The only dependency is `regex`.

## Install

```sh
cargo add clyops
```

Compiled clyops binaries embed their completion header, which is how the
dispatcher, API and MCP server recognize them: no marker comment needed.

## Registration

`group` and `rule` are chained on the handle `opt` returns, on the same line.
Add `#[rustfmt::skip]` to the function so rustfmt keeps one registration per
line.

```rust
use clyops::{die, info, Cli};

let mut cli = Cli::new();
cli.name("plan");                                           // also .root(path)
cli.opt(VAR, long, short, default, description).group(G).rule(R);
cli.opt_array(VAR, long, short, description).group(G).rule(R);
cli.arg(NAME, description, default, rule);                  // all four arguments
cli.arg_variadic(NAME, description, rule);
```

Metadata: `description`, `epilog`, `config(option, prefixes)`,
`path_search(long, dirs)`, `require_command(cmd, description, hint)`,
`effects(&[...])`, `stdin(description, content_type)`,
`stdout(description, content_type)`, `exclusive(&[...])`,
`requires(first, &[rest...])`, `one_of(&[...])`, `command(name, description)`.

## Values

`let args = cli.run();` returns `Values` with typed getters: `str`, `int`
(`i64`), `float`, `bool`, `strs` (arrays/variadics, and `"command"`), plus
`get(name)` for the tagged `Value`. `cli.command_path()` is the selected
command words.

Also `cli.source(long)`, `cli.values_json()`, and non-exiting `cli.parse(argv)`.

## Logging

`info`, `warn`, `error`, `success` take `&str` (use `format!`);
`die(code, &str)` logs and exits; `set_silent(true)`.

## Example

```rust
use clyops::Cli;

// Keep one registration per line; rustfmt would split the chains.
#[rustfmt::skip]
fn main() {
    let mut cli = Cli::new();
    cli.name("plan");
    cli.description("Build a deployment plan. Change nothing.");
    cli.opt("SERVICE", "service", "s", "api", "Service").rule("choice:api,worker");
    cli.opt("ENV", "env", "e", "staging", "Environment").rule("choice:staging,production");
    cli.opt("REPLICAS", "replicas", "r", "2", "Replica count").rule("int:1-10");
    cli.opt_array("TAG", "tag", "t", "Labels to attach").rule("string:1-40");
    cli.opt("WEBHOOK", "webhook", "", "optional", "Notify this webhook").group("Notification").rule("url");
    cli.opt("EMAIL", "email", "", "optional", "Notify this email address").group("Notification").rule("email");
    cli.exclusive(&["webhook", "email"]);
    cli.effects(&["read-only"]);
    cli.stdout("Deployment plan", "text/plain");
    let args = cli.run();

    // Our tool's logic starts here, after the interface is fully declared.
    println!("service={} env={} replicas={} tags={}", args.str("SERVICE"), args.str("ENV"),
        args.int("REPLICAS"), args.strs("TAG").join(","));
}
```

## Commands

```rust
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output").group("Global"); // program options first
let db = cli.command("db", "Database tasks");
db.opt("DB_URL", "url", "u", "sqlite:app.db", "Database URL").group("Database");
let migrate = db.command("migrate", "Apply migrations");
migrate.arg("target", "Target version", "latest", "");
migrate.opt("DRY_RUN", "dry-run", "n", "flag", "Show what would run");
migrate.effects(&["destructive"]);
db.command("status", "Show migration status").effects(&["read-only"]);
let args = cli.run();
if args.strs("command") == ["db", "migrate"] { /* ... */ }
```
