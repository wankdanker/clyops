//! The conformance demo CLI (spec/conformance/README.md) in Rust.
use clyops::Cli;

// Keep one registration per line; rustfmt would split the chains.
#[rustfmt::skip]
fn main() {
    let mut cli = Cli::new();
    cli.name("demo").root(&std::env::var("DEMO_ROOT").unwrap_or_else(|_| ".".into()));
    cli.description("Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values.");
    cli.epilog("Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf");
    cli.require_command("sh", "POSIX shell", "install dash");

    cli.arg("input", "Input file", "", "path");
    cli.arg("mode", "Processing mode", "fast", "choice:fast,slow");
    cli.arg_variadic("rest", "Extra items", "");

    cli.opt("CONFIG",   "config",   "c", "optional",  "Config file to load").group("Config").rule("path");
    cli.opt("VERBOSE",  "verbose",  "v", "flag",      "Enable verbose output").group("Output");
    cli.opt("QUIET",    "quiet",    "q", "flag",      "Suppress output").group("Output");
    cli.opt("COLOR",    "color",    "",  "auto",      "When to use color").group("Output").rule("choice:auto,always,never");
    cli.opt("OUT",      "out",      "o", "out.txt",   "Output path").group("Output").rule("path");
    cli.opt("NOTES",    "notes",    "",  "optional",  "Free-form notes. This description is deliberately long so that the help output has to wrap it onto several lines at the default width of one hundred columns.").group("Output");
    cli.opt("COUNT",    "count",    "n", "3",         "Number of iterations").rule("int:1-10");
    cli.opt("RATIO",    "ratio",    "",  "0.5",       "Mix ratio").rule("float:0-1");
    cli.opt("ENABLED",  "enabled",  "",  "true",      "Enable processing").rule("bool");
    cli.opt_array("TAG", "tag",     "t",              "Tag to attach").rule("string:1-8");
    cli.opt("NO_CACHE", "no-cache", "",  "flag",      "Disable the cache");
    cli.opt("KEY",      "key",      "k", "",          "API key").group("Auth");
    cli.opt("HOST",     "host",     "H", "localhost", "Server host").group("Network").rule("hostname");
    cli.opt("PORT",     "port",     "p", "8080",      "Server port").group("Network").rule("port");
    cli.opt("ENDPOINT", "endpoint", "",  "optional",  "Endpoint URL").group("Network").rule("url");
    cli.opt("ADDR",     "addr",     "",  "optional",  "Bind address").group("Network").rule("ip");
    cli.opt("ID",       "id",       "",  "optional",  "Request identifier").group("Validation").rule("uuid");
    cli.opt("EMAIL",    "email",    "",  "optional",  "Contact email").group("Validation").rule("email");
    cli.opt("DATE",     "date",     "",  "optional",  "Start date").group("Validation").rule("date:YYYY-MM-DD");
    cli.opt("CODE",     "code",     "",  "optional",  "Three-letter code").group("Validation").rule("regex:^[A-Z]{3}$");
    cli.opt("LEVEL",    "level",    "",  "optional",  "Level").group("Validation").rule("int");
    cli.opt("SIZE",     "size",     "",  "optional",  "Size code").group("Validation").rule("string:4");
    cli.opt("DATA_DIR", "data-dir", "d", "optional",  "Data directory").group("Files").rule("dir:exists");
    cli.opt("SRC",      "src",      "",  "optional",  "Source file").group("Files").rule("file:exists");
    cli.opt("DEST",     "dest",     "",  "optional",  "Destination file").group("Files").rule("file:writable");
    cli.opt_array("INCLUDE", "include", "I",          "Include directory").group("Files").rule("path");

    cli.config("config", "demo:,shared:");
    cli.path_search("config", "conf");

    cli.run();

    let longs = ["config", "verbose", "quiet", "color", "out", "notes", "count", "ratio", "enabled", "tag", "no-cache", "key",
        "host", "port", "endpoint", "addr", "id", "email", "date", "code", "level", "size", "data-dir", "src", "dest", "include", "help"];
    let sources: Vec<String> = longs.iter().map(|l| format!("\"{l}\": \"{}\"", cli.source(l))).collect();
    println!("{{\"values\": {}, \"sources\": {{{}}}}}", cli.values_json(), sources.join(", "));
}
