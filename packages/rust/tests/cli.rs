use clyops::{describe_rule, resolve_path, validate, wrap_text, Cli, Parsed, Value};

fn make() -> Cli {
    let mut cli = Cli::new();
    cli.name("t").env(Vec::new()).cwd("/work").root("/root");
    cli.arg("file", "File", "", "path");
    cli.opt("COUNT", "count", "n", "2", "Count").rule("int:1-5");
    cli.opt("FAST", "fast", "f", "flag", "Fast");
    cli.opt_array("TAG", "tag", "t", "Tags");
    cli
}

#[test]
fn parse_returns_typed_values() {
    let mut cli = make();
    assert_eq!(cli.parse(&["a.txt", "-fn", "4", "-t", "x", "--tag=y"]), Parsed::Ok);
    let v = cli.values();
    assert_eq!(v.str("file"), "/work/a.txt");
    assert_eq!(v.int("COUNT"), 4);
    assert!(v.bool("FAST"));
    assert_eq!(v.strs("TAG"), vec!["x", "y"]);
    assert!(cli.is_set("--fast"));
    assert_eq!(cli.source("count"), "cli");
}

#[test]
fn parse_reports_errors_and_help() {
    match make().parse(&["a", "--count", "9"]) {
        Parsed::Error { message, show_usage, .. } => {
            assert_eq!(message, "--count must be <= 5, got 9");
            assert!(show_usage);
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(make().parse(&["--help"]), Parsed::Help);
}

#[test]
fn environment_by_variable_name() {
    let mut cli = Cli::new();
    cli.env([("COUNT".to_string(), "3".to_string())]);
    cli.opt("COUNT", "count", "", "1", "Count").rule("int");
    assert_eq!(cli.parse::<&str>(&[]), Parsed::Ok);
    assert_eq!(cli.values().get("COUNT"), &Value::Int(3));
    assert_eq!(cli.source("count"), "env");
}

#[test]
#[should_panic(expected = "Unknown validation rule 'nope' for --a")]
fn unknown_rule_panics() {
    Cli::new().opt("A", "a", "", "", "A").rule("nope");
}

#[test]
#[should_panic(expected = "after a variadic")]
fn arg_after_variadic_panics() {
    let mut cli = Cli::new();
    cli.arg_variadic("r", "R", "");
    cli.arg("x", "X", "", "");
}

#[test]
fn validate_converts_and_explains() {
    assert_eq!(validate("ON", "bool", "v"), Ok(Value::Bool(true)));
    assert_eq!(validate("-2.5", "float:-3", "v"), Ok(Value::Float(-2.5)));
    assert_eq!(validate("abcd", "string:-3", "--s"), Err("--s must be at most 3 characters, got 4".into()));
    assert_eq!(describe_rule("string:2-"), "text: >=2 chars");
}

#[test]
fn resolve_path_passes_through_special_values() {
    assert_eq!(resolve_path("-", "/b", &[]), "-");
    assert_eq!(resolve_path("s3://bucket/key", "/b", &[]), "s3://bucket/key");
    assert_eq!(resolve_path("../x", "/b/c", &[]), "/b/x");
}

#[test]
fn wrap_text_keeps_paragraphs_and_long_words() {
    assert_eq!(wrap_text("aa bb cc\n\nsupercalifragilistic dd", 5), vec!["aa bb", "cc", "", "supercalifragilistic", "dd"]);
}

#[test]
#[should_panic(expected = "Unknown effect 'sideways'")]
fn unknown_effect_panics() {
    Cli::new().effects(&["sideways"]);
}

#[test]
#[should_panic(expected = "Unknown option --b in constraint")]
fn constraint_on_unknown_option_panics() {
    let mut cli = Cli::new();
    cli.opt("A", "a", "", "flag", "A");
    cli.exclusive(&["a", "b"]);
}

#[test]
#[should_panic(expected = "Cannot mix commands and positional arguments")]
fn commands_and_arguments_do_not_mix() {
    let mut cli = Cli::new();
    cli.arg("x", "X", "", "");
    cli.command("c", "C");
}

#[test]
fn secret_values_are_masked() {
    let mut cli = Cli::new();
    cli.name("t").env(Vec::new());
    cli.opt("TOKEN", "token", "", "", "Token").rule("secret:string:3-");
    assert_eq!(cli.parse(&["--token", "abcd"]), Parsed::Ok);
    assert_eq!(cli.values().str("TOKEN"), "abcd");
    assert!(cli.values_json().contains("\"TOKEN\": \"***\""));
    let schema = cli.json_schema();
    assert!(schema.contains("\"validation\": \"string:3-\"") && schema.contains("\"secret\": true"));
}

fn related(env: Vec<(String, String)>) -> Cli {
    let mut cli = Cli::new();
    cli.name("t").env(env);
    cli.opt("A", "a", "a", "flag", "A");
    cli.opt("B", "b", "b", "flag", "B");
    cli.opt("C", "c", "c", "optional", "C");
    cli.exclusive(&["a", "b"]).requires("c", &["a"]).one_of(&["a", "b", "c"]);
    cli
}

fn error_of(p: Parsed) -> String {
    match p {
        Parsed::Error { message, .. } => message,
        other => format!("{other:?}"),
    }
}

#[test]
fn relationships() {
    assert_eq!(error_of(related(Vec::new()).parse(&["-a", "-b"])), "Options --a and --b cannot be used together");
    assert_eq!(related(Vec::new()).parse(&["-a", "--no-b"]), Parsed::Ok);
    assert_eq!(error_of(related(Vec::new()).parse(&["-c", "x"])), "Option --c requires --a");
    assert_eq!(related(vec![("A".into(), "true".into())]).parse(&["-c", "x"]), Parsed::Ok);
    assert_eq!(error_of(related(Vec::new()).parse::<&str>(&[])), "One of --a, --b, --c is required");
}

#[test]
fn commands() {
    let mut cli = Cli::new();
    cli.name("m").env(Vec::new());
    cli.opt("CONFIG", "config", "c", "optional", "Config").group("Global");
    let migrate = cli.command("db", "Database").command("migrate", "Migrate");
    migrate.opt("TO", "to", "", "optional", "Target").rule("int");
    migrate.arg("name", "Name", "all", "");
    assert_eq!(cli.parse(&["db", "-c", "x", "migrate", "--to", "3"]), Parsed::Ok);
    assert_eq!(cli.command_path(), vec!["db", "migrate"]);
    assert_eq!((cli.values().int("TO"), cli.values().str("CONFIG")), (3, "x"));
    assert_eq!(cli.values().strs("command"), vec!["db", "migrate"]);
    assert_eq!(error_of(cli.parse(&["--to", "3", "db", "migrate"])), "Unknown option: --to");
    assert_eq!(error_of(cli.parse(&["db"])), "Missing command");
    assert_eq!(error_of(cli.parse(&["db", "seed"])), "Unknown command: seed");
    assert_eq!(cli.parse(&["db", "migrate", "-h"]), Parsed::Help);
    assert!(cli.usage().starts_with("Usage: m db migrate [<name>] [OPTIONS]"));
}
