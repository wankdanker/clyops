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

#[test]
fn role_registration_errors_panic() {
    let cases: [(&str, fn()); 4] = [
        ("Invalid role name '7up'", || {
            Cli::new().role("7up", "out", "X", "");
        }),
        ("Invalid role name 'a:b'", || {
            Cli::new().role("a:b", "out", "X", "");
        }),
        ("Unknown role direction 'both'", || {
            Cli::new().role("log", "both", "X", "");
        }),
        ("Duplicate role 'log'", || {
            let mut c = Cli::new();
            c.role("log", "out", "X", "");
            c.role("log", "in", "Y", "");
        }),
    ];
    for (message, register) in cases {
        let err = std::panic::catch_unwind(register).expect_err(message);
        assert_eq!(err.downcast_ref::<String>().cloned().unwrap_or_default(), message);
    }
}

#[test]
fn role_schema_is_embedded_json() {
    let mut cli = Cli::new();
    cli.name("t").env(Vec::new());
    cli.role("meta", "out", "A", "application/json").schema(r#"{"type":"object"}"#);
    cli.role("extra", "in", "B", "");
    let compact: String = cli.json_schema().split_whitespace().collect();
    assert!(compact.contains(r#""roles":[{"name":"meta","direction":"out","description":"A","contentType":"application/json","schema":{"type":"object"}},{"name":"extra","direction":"in","description":"B","contentType":"","schema":null}]"#), "{compact}");
}

#[test]
fn role_emit_and_forward_follow_the_mapping() {
    use std::os::fd::AsRawFd;
    let path = std::env::temp_dir().join(format!("clyops-fd-{}", std::process::id()));
    let file = std::fs::File::create(&path).unwrap();
    let fd = file.as_raw_fd();
    let make = |mapping: &str| {
        let mut cli = Cli::new();
        let env = if mapping.is_empty() { vec![] } else { vec![("CLYOPS_FDS".to_string(), mapping.to_string())] };
        cli.name("t").env(env);
        cli.role("progress", "out", "Progress", "");
        cli.role("extra", "in", "Extra", "");
        assert_eq!(cli.parse(&[] as &[&str]), Parsed::Ok);
        cli
    };
    let unmapped = make("");
    assert_eq!(unmapped.fd_open("progress"), None);
    unmapped.emit("progress", "never");
    assert_eq!(unmapped.forward_fds(&["progress"]), "");
    let cli = make(&format!("progress:{fd}, extra:999, log:{fd}"));
    assert_eq!(cli.fd_open("progress"), Some(fd));
    assert_eq!(cli.fd_open("extra"), None);
    assert_eq!(cli.fd_open("log"), None);
    cli.emit("progress", r#"{"pct":50}"#);
    cli.emit("progress", "plain text");
    cli.emit("progress", "ends with newline\n");
    assert_eq!(cli.forward_fds(&["progress", "extra", "log", "nope"]), format!("progress:{fd},log:{fd}"));
    let err = std::panic::catch_unwind(|| cli.emit("nope", "x")).unwrap_err();
    assert_eq!(err.downcast_ref::<String>().unwrap(), "Unknown role 'nope'");
    let err = std::panic::catch_unwind(|| cli.emit("extra", "x")).unwrap_err();
    assert_eq!(err.downcast_ref::<String>().unwrap(), "Role 'extra' is not an output");
    drop(file);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"pct\":50}\nplain text\nends with newline\n");
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn role_scope_and_help() {
    let mut cli = Cli::new();
    cli.name("m").env(vec![("CLYOPS_FDS".to_string(), "progress:2,plan:2".to_string())]);
    cli.role("progress", "out", "Progress", "application/x-ndjson");
    let db = cli.command("db", "Database");
    db.command("migrate", "Migrate").role("plan", "out", "Migration plan", "");
    db.command("status", "Status");
    assert_eq!(cli.parse(&["db", "status"]), Parsed::Ok);
    assert_eq!(cli.fd_open("progress"), Some(2));
    assert_eq!(cli.fd_open("plan"), None);
    assert_eq!(cli.parse(&["db", "migrate"]), Parsed::Ok);
    assert_eq!(cli.fd_open("plan"), Some(2));
    let usage = cli.usage();
    assert!(usage.contains("\nOutput [plan]: Migration plan\n"), "{usage}");
    assert!(!usage.contains("[progress]"));
}
