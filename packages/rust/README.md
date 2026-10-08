# clyops (Rust)

One-line-per-option CLI parsing with validation, help text, JSON schema, config files and shell
completion. See the [main README](https://github.com/wankdanker/clyops).

```rust
use clyops::Cli;

let mut cli = Cli::new();
cli.arg("input", "Input file", "", "path");
cli.opt("PORT", "port", "p", "8080", "Server port").group("Network").rule("port");
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output");
let args = cli.run();
println!("{} {} {}", args.str("input"), args.int("PORT"), args.bool("VERBOSE"));
```

rustfmt splits long method chains; put `#[rustfmt::skip]` on the function that registers options
to keep one registration per line.
