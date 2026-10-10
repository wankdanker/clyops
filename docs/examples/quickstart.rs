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
