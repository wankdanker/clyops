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
