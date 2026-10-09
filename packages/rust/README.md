# clyops (Rust)

One-line-per-option CLI parsing with validation, help text, config files, JSON schema, logging and
shell completion. Only dependency: `regex`. See the [main README](https://github.com/wankdanker/clyops).

```rust
use clyops::{info, Cli};

#[rustfmt::skip]
fn main() {
    let mut cli = Cli::new();
    cli.description("Copy files to a server.");
    cli.arg("SRC", "File to send", "", "file:exists");
    cli.arg_variadic("EXTRA", "More files", "file:exists");
    cli.opt("HOST", "host", "H", "localhost", "Server").group("Network").rule("hostname");
    cli.opt("PORT", "port", "p", "22", "Port").group("Network").rule("port");
    cli.opt("VERBOSE", "verbose", "v", "flag", "Chatty");
    cli.opt("CONFIG", "config", "c", "optional", "Config file").group("Config").rule("path");
    cli.config("config", "send:");
    let args = cli.run();

    info(&format!("sending {} to {}:{}", args.str("SRC"), args.str("HOST"), args.int("PORT")));
}
```

`run()` returns typed `Values` (`str`, `int`, `float`, `bool`, `strs`, `get`); `parse(&argv)` is the
non-exiting variant and returns `Parsed::{Ok, Help, Error}`. Registration mistakes (unknown rule,
duplicate name) panic. rustfmt splits long method chains, so `#[rustfmt::skip]` on the function
that registers options keeps one registration per line.

## Commands, relationships, secrets, effects and I/O

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
