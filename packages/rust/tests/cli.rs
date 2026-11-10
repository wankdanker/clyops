use clyops::{describe_rule, resolve_path, validate, wrap_text, Cli, CompleteRequest, Parsed, Value, ValuesPage};

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

#[test]
#[should_panic(expected = "Unknown option or argument 'nope' for complete")]
fn complete_unknown_name_panics() {
    make().complete("nope", |_| Ok(Vec::new()));
}

#[test]
#[should_panic(expected = "Flag --fast takes no value to complete")]
fn complete_flag_panics() {
    make().complete("fast", |_| Ok(Vec::new()));
}

fn record<'a>(data: &'a str, prefix: &str) -> &'a str {
    data.lines().find(|l| l.starts_with(prefix)).unwrap_or_else(|| panic!("no record {prefix} in {data}"))
}

#[test]
fn completers_fill_completion_records() {
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = calls.clone();
    let mut cli = make();
    cli.complete("count", move |request| {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert_eq!((request.prefix.as_str(), request.limit, request.offset), ("", 0, 0));
        let mut list: Vec<String> = ["b", "", "a,b", "a b", "x\ty", "b", "c"].iter().map(|s| s.to_string()).collect();
        list.extend(request.words.iter().map(|w| format!("w:{w}")));
        Ok(list)
    });
    cli.complete("file", |_| Ok(Vec::new()));
    cli.complete("tag", |_| Err("no tags".into()));
    assert_eq!(cli.parse(&["x", "-n", "3"]), Parsed::Ok);
    let _ = (cli.usage(), cli.json_schema());
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0, "only completion runs a completer");
    let data = cli.completion_data_for(&["x", "y"]);
    assert_eq!(record(&data, "opt\t--count"), "opt\t--count\t-n\tvalue\tchoice\tb,c,w:x,w:y\tCount");
    assert_eq!(record(&data, "arg\tfile"), "arg\tfile\tsingle\tchoice\t-\tFile");
    assert_eq!(record(&data, "opt\t--tag"), "opt\t--tag\t-t\tvalue\tdefault\t-\tTags");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn panicking_completer_keeps_the_rule() {
    let mut cli = make();
    cli.complete("file", |_| panic!("boom"));
    let data = cli.completion_data();
    assert_eq!(record(&data, "arg\tfile"), "arg\tfile\tsingle\tfile\t-\tFile");
}

#[test]
fn completers_get_the_words_after_the_commands() {
    let mut cli = Cli::new();
    cli.name("m").env(Vec::new());
    cli.opt("CONFIG", "config", "c", "optional", "Config");
    cli.complete("config", |request| Ok(vec![format!("top-{}", request.words.join("+"))]));
    let migrate = cli.command("db", "Database").command("migrate", "Migrate");
    migrate.arg("name", "Name", "all", "");
    migrate.complete("name", |request| Ok(request.words.clone()));
    let data = cli.completion_data_for(&["db", "migrate", "a", "b"]);
    assert_eq!(record(&data, "skip"), "skip\t2");
    assert_eq!(record(&data, "opt\t--config"), "opt\t--config\t-c\tvalue\tchoice\ttop-a+b\tConfig");
    assert_eq!(record(&data, "arg\tname"), "arg\tname\tsingle\tchoice\ta,b\tName");
}

#[test]
fn schema_marks_dynamic_values() {
    let mut cli = make();
    cli.complete("count", |_| Ok(Vec::new()));
    let compact: String = cli.json_schema().split_whitespace().collect();
    assert!(compact.contains(r#""name":"file","description":"File","required":true,"isVariadic":false,"default":"","validation":"path","schema":null,"dynamic":false"#), "{compact}");
    assert!(compact.contains(r#""secret":false,"dynamic":true"#), "{compact}");
    assert!(compact.contains(r#""name":"tag","#) && compact.matches(r#""dynamic":true"#).count() == 1, "{compact}");
}

fn page(values: &[&str], more: bool) -> ValuesPage {
    ValuesPage { values: values.iter().map(|v| v.to_string()).collect(), more }
}

#[test]
fn complete_values_pages_for_the_completer_unless_it_is_paged() {
    let mut cli = make();
    cli.complete("count", |_| {
        Ok(["alpha", "beta", "albert", "has space", "a,b", "alpha", ""].iter().map(|v| v.to_string()).collect())
    });
    assert_eq!(cli.complete_values("count", "", 10, 0, &[]), Ok(page(&["alpha", "beta", "albert", "has space", "a,b"], false)));
    assert_eq!(cli.complete_values("count", "al", 1, 0, &[]), Ok(page(&["alpha"], true)));
    assert_eq!(cli.complete_values("count", "al", 1, 1, &[]), Ok(page(&["albert"], false)));

    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    let mut paged = make();
    paged.complete_paged("count", move |request| {
        log.lock().unwrap().push(request.clone());
        Ok(["x", "y", "z"].iter().take(request.limit).map(|v| v.to_string()).collect())
    });
    assert_eq!(paged.complete_values("count", "q", 2, 40, &["-f"]), Ok(page(&["x", "y"], true)));
    let want = CompleteRequest { words: vec!["-f".into()], prefix: "q".into(), limit: 3, offset: 40 };
    assert_eq!(*seen.lock().unwrap(), vec![want]);
    // Registering again replaces the completer and its mode.
    paged.complete("count", |_| Ok(vec!["only".into()]));
    assert_eq!(paged.complete_values("count", "", 5, 0, &[]), Ok(page(&["only"], false)));

    assert_eq!(make().complete_values("count", "", 5, 0, &[]), Err("No completer for 'count'".to_string()));
    let mut failing = make();
    failing.complete("count", |_| Err("x".into()));
    assert_eq!(failing.complete_values("count", "", 5, 0, &[]), Err("Completer for 'count' failed".to_string()));
    failing.complete("count", |_| panic!("boom"));
    assert_eq!(failing.complete_values("count", "", 5, 0, &[]), Err("Completer for 'count' failed".to_string()));

    // Shell completion keeps at most 1000 values.
    let mut many = make();
    many.complete("count", |_| Ok((0..1500).map(|i| format!("v{i}")).collect()));
    let data = many.completion_data();
    assert_eq!(record(&data, "opt\t--count").split('\t').nth(5).unwrap().split(',').count(), 1000);
}

#[test]
fn complete_values_follows_commands() {
    let mut cli = Cli::new();
    cli.name("t").env(Vec::new());
    let db = cli.command("db", "Database");
    db.opt("URL", "url", "", "optional", "URL");
    db.complete("url", |_| Ok(vec!["pg:main".into()]));
    let migrate = db.command("migrate", "Migrate");
    migrate.arg("target", "Target", "", "");
    migrate.complete("target", |request| Ok(request.words.clone()));
    assert_eq!(cli.complete_values("url", "", 5, 0, &["db", "migrate"]), Ok(page(&["pg:main"], false)));
    assert_eq!(cli.complete_values("target", "", 5, 0, &["db", "migrate", "-n", "x"]), Ok(page(&["-n", "x"], false)));
    assert_eq!(cli.complete_values("target", "", 5, 0, &["db"]), Err("No completer for 'target'".to_string()));
    assert_eq!(cli.complete_values("url", "", 5, 0, &[]), Err("No completer for 'url'".to_string()));
}
