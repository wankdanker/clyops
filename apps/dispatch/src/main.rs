//! clyops-dispatch: turn a directory of tools into one command with nested
//! subcommands, help and shell completion (spec/SPEC.md section 12).
//!
//! A dispatcher is a small definition file whose shebang runs this program:
//!
//! ```text
//! #!/usr/bin/env clyops-dispatch
//! description: mytool toolchain
//! ignore: lib, docx
//! ```
//!
//! Executables next to it become subcommands named after their basename, and
//! subdirectories become groups of subcommands. Without a definition file, a
//! shell alias works too:
//!
//! ```text
//! alias mytool='clyops-dispatch --root ~/mytool/scripts --name mytool'
//! ```

use clyops::{die, wrap_text, Cli};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

/// How long a tool may take to answer --help-json-schema or --bash-completion.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Tools probed at the same time while building a listing.
const PROBE_PARALLELISM: usize = 16;

// ---------------------------------------------------------------------------
// Definitions and the command tree
// ---------------------------------------------------------------------------

/// Settings from a dispatcher definition or a group's `.clyops` file.
#[derive(Default)]
struct Settings {
    description: String,
    dir: Option<String>,
    ignore: Vec<String>,
}

fn read_settings(path: &Path, allow_dir: bool) -> Settings {
    let text = fs::read_to_string(path).unwrap_or_else(|e| die(1, &format!("Cannot read {}: {e}", path.display())));
    let mut settings = Settings::default();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            die(1, &format!("{}:{}: expected 'key: value'", path.display(), n + 1));
        };
        let value = value.trim().to_string();
        match key.trim() {
            "description" => settings.description = value,
            "ignore" => settings.ignore = value.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            "dir" if allow_dir => settings.dir = Some(value),
            // Which tools clyops-api and clyops-mcp serve; running them here is up to the user.
            "allow" | "deny" => {}
            other => die(1, &format!("{}:{}: unknown key '{other}'", path.display(), n + 1)),
        }
    }
    settings
}

#[derive(Clone)]
enum Entry {
    Command { name: String, path: PathBuf },
    Group { name: String, path: PathBuf },
}

impl Entry {
    fn name(&self) -> &str {
        match self {
            Entry::Command { name, .. } | Entry::Group { name, .. } => name,
        }
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.BAT;.CMD;.COM".into()).to_ascii_lowercase();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase())).unwrap_or_default();
    path.is_file() && exts.split(';').any(|x| x == ext)
}

/// A command's name: the file name without its last extension.
fn command_name(file_name: &str) -> String {
    match file_name.rfind('.') {
        Some(i) if i > 0 => file_name[..i].to_string(),
        _ => file_name.to_string(),
    }
}

/// The dispatcher: its name, root directory, and the definition file to skip.
struct Dispatcher {
    prog: String,
    root: PathBuf,
    /// The definition file, when run from one (not with --root).
    definition: Option<PathBuf>,
    description: String,
    root_ignore: Vec<String>,
}

impl Dispatcher {
    fn load(definition: &Path) -> Dispatcher {
        let prog = definition.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // Symlinks into PATH are common: the tools live next to the real file.
        let real = fs::canonicalize(definition).unwrap_or_else(|e| die(1, &format!("{}: {e}", definition.display())));
        let settings = read_settings(&real, true);
        let base = real.parent().unwrap_or(Path::new("/")).to_path_buf();
        let root = match &settings.dir {
            Some(dir) => base.join(dir),
            None => base,
        };
        if !root.is_dir() {
            die(1, &format!("{}: dir '{}' is not a directory", real.display(), root.display()));
        }
        Dispatcher { prog, root, definition: Some(real), description: settings.description, root_ignore: settings.ignore }
    }

    /// `--root DIR [--name NAME]`: no definition file; the root's optional
    /// `.clyops` file gives the description and ignore list.
    fn from_root(root: &Path, name: Option<String>) -> Dispatcher {
        let root = fs::canonicalize(root).unwrap_or_else(|e| die(1, &format!("--root {}: {e}", root.display())));
        if !root.is_dir() {
            die(1, &format!("--root {} is not a directory", root.display()));
        }
        let file = root.join(".clyops");
        let settings = if file.is_file() { read_settings(&file, false) } else { Settings::default() };
        let prog = name.unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        Dispatcher { prog, root, definition: None, description: settings.description, root_ignore: settings.ignore }
    }

    /// Settings for a group directory (its optional `.clyops` file).
    fn group_settings(&self, dir: &Path) -> Settings {
        if dir == self.root {
            return Settings { description: self.description.clone(), dir: None, ignore: self.root_ignore.clone() };
        }
        let file = dir.join(".clyops");
        if file.is_file() {
            read_settings(&file, false)
        } else {
            Settings::default()
        }
    }

    /// Commands and groups directly inside `dir`, sorted by name. A group
    /// shadows a command of the same name.
    fn entries(&self, dir: &Path) -> Vec<Entry> {
        let ignore = self.group_settings(dir).ignore;
        let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
        let mut files: Vec<(String, PathBuf)> = read
            .filter_map(Result::ok)
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
            .filter(|(name, _)| !name.starts_with('.'))
            .collect();
        files.sort();

        let mut by_name: HashMap<String, Entry> = HashMap::new();
        for (file_name, path) in files {
            let name = command_name(&file_name);
            if ignore.iter().any(|i| *i == file_name || *i == name) {
                continue;
            }
            if path.is_dir() {
                if self.has_commands(&path) {
                    by_name.insert(file_name.clone(), Entry::Group { name: file_name, path });
                }
            } else if is_executable(&path) && fs::canonicalize(&path).ok() != self.definition {
                by_name.entry(name.clone()).or_insert(Entry::Command { name, path });
            }
        }
        let mut entries: Vec<Entry> = by_name.into_values().collect();
        entries.sort_by(|a, b| a.name().cmp(b.name()));
        entries
    }

    fn has_commands(&self, dir: &Path) -> bool {
        !self.entries(dir).is_empty()
    }

    /// Follow `words` from the root through groups. Returns the group reached,
    /// the number of words consumed, and the command if one was reached.
    fn walk(&self, words: &[String]) -> (PathBuf, Vec<String>, Option<PathBuf>) {
        let mut dir = self.root.clone();
        let mut path = Vec::new();
        for word in words {
            match self.entries(&dir).into_iter().find(|e| e.name() == word) {
                Some(Entry::Group { path: p, .. }) => {
                    dir = p;
                    path.push(word.clone());
                }
                Some(Entry::Command { path: p, .. }) => {
                    path.push(word.clone());
                    return (dir, path, Some(p));
                }
                None => break,
            }
        }
        (dir, path, None)
    }
}

// ---------------------------------------------------------------------------
// Descriptions: probed from --help-json-schema and cached by file mtime
// ---------------------------------------------------------------------------

/// What an executable is, judged from its contents. Only clyops programs are
/// run to ask for their schema or completion data: running an arbitrary
/// executable with an unknown flag could do real work.
#[derive(PartialEq)]
enum Kind {
    /// Uses a clyops library.
    Tool,
    /// Another dispatcher definition (its shebang runs clyops-dispatch).
    Dispatcher,
    Other,
}

/// Strings found in programs built on a clyops library: the completion
/// header compiled into C and Rust binaries, how scripts load the Bash,
/// Python and JavaScript libraries, and a `# clyops-tool` comment that
/// wrapper scripts can add to opt in.
const MARKERS: [&[u8]; 7] =
    [b"#clyops-completion", b"clyops.sh", b"import clyops", b"from clyops", b"'clyops'", b"\"clyops\"", b"clyops-tool"];

fn classify(path: &Path) -> Kind {
    let mut bytes = Vec::new();
    if fs::File::open(path).and_then(|mut f| f.read_to_end(&mut bytes)).is_err() {
        return Kind::Other;
    }
    let first_line = bytes.split(|b| *b == b'\n').next().unwrap_or_default();
    if first_line.starts_with(b"#!") && first_line.windows(15).any(|w| w == b"clyops-dispatch") {
        return Kind::Dispatcher;
    }
    if MARKERS.iter().any(|m| bytes.windows(m.len()).any(|w| w == *m)) {
        Kind::Tool
    } else {
        Kind::Other
    }
}

/// Run `path args...` and return stdout if it exits successfully in time.
/// Tools run in the caller's directory, as they would if run directly.
fn probe(path: &Path, args: &[String]) -> Option<String> {
    let mut child =
        Command::new(path).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if start.elapsed() < PROBE_TIMEOUT => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

fn cache_file() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))?;
    Some(base.join("clyops-dispatch").join("descriptions.json"))
}

/// A cache key that changes whenever the file does.
fn stamp(path: &Path) -> String {
    let meta = fs::metadata(path).ok();
    let mtime =
        meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos());
    format!("{}:{}", mtime.unwrap_or(0), meta.map(|m| m.len()).unwrap_or(0))
}

/// One-line descriptions for commands, probing only what the cache lacks.
fn describe(commands: &[PathBuf]) -> HashMap<PathBuf, String> {
    let file = cache_file();
    let mut cache: serde_json::Map<String, serde_json::Value> =
        file.as_ref().and_then(|f| fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();

    let mut out = HashMap::new();
    let mut todo = Vec::new();
    for path in commands {
        let key = path.to_string_lossy().into_owned();
        let stamp = stamp(path);
        match cache.get(&key) {
            Some(entry) if entry["stamp"] == stamp.as_str() => {
                out.insert(path.clone(), entry["description"].as_str().unwrap_or("").to_string());
            }
            _ => todo.push((path.clone(), key, stamp)),
        }
    }

    for chunk in todo.chunks(PROBE_PARALLELISM) {
        let handles: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|(path, key, stamp)| {
                std::thread::spawn(move || {
                    let description = match classify(&path) {
                        Kind::Tool => probe(&path, &["--help-json-schema".into()])
                            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                            .and_then(|schema| schema["description"].as_str().map(first_line))
                            .unwrap_or_default(),
                        Kind::Dispatcher => first_line(&read_settings(&path, true).description),
                        Kind::Other => String::new(),
                    };
                    (path, key, stamp, description)
                })
            })
            .collect();
        for handle in handles {
            if let Ok((path, key, stamp, description)) = handle.join() {
                cache.insert(key, serde_json::json!({ "stamp": stamp, "description": description }));
                out.insert(path, description);
            }
        }
    }

    // The cache only saves time; failing to write it is harmless.
    if let (Some(file), false) = (file, todo.is_empty()) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, serde_json::Value::Object(cache).to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/// Help for one level of the tree, in the same layout as clyops help text.
fn usage(d: &Dispatcher, dir: &Path, path: &[String]) -> String {
    let entries = d.entries(dir);
    let commands: Vec<PathBuf> =
        entries.iter().filter_map(|e| if let Entry::Command { path, .. } = e { Some(path.clone()) } else { None }).collect();
    let descriptions = describe(&commands);

    let max_width =
        std::env::var("CLYOPS_MAX_WIDTH").ok().and_then(|w| w.parse::<usize>().ok()).filter(|w| *w > 0).unwrap_or(100);
    let global = [
        ("-h, --help", "Show this help message and exit"),
        ("    --completion=<value>", "Print a completion script for bash, zsh or fish"),
    ];
    let longest = entries.iter().map(|e| e.name().chars().count()).chain(global.iter().map(|g| g.0.len())).max().unwrap_or(0);
    let indent = (longest + 4).clamp(32, 50);
    let width = max_width.saturating_sub(indent).max(20);
    let row = |label: &str, text: &str| -> String {
        let mut left = format!("  {label}");
        let len = left.chars().count();
        if len < indent {
            left.push_str(&" ".repeat(indent - len))
        } else {
            left.push(' ')
        }
        let lines = wrap_text(text, width);
        let mut out = format!("{left}{}", lines[0]).trim_end().to_string();
        for line in &lines[1..] {
            out.push('\n');
            out.push_str(format!("{}{line}", " ".repeat(indent)).trim_end());
        }
        out
    };

    let prefix = std::iter::once(d.prog.as_str()).chain(path.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
    let mut sections = vec![format!("Usage: {prefix} <command> [args...]")];
    let description = d.group_settings(dir).description;
    if !description.is_empty() {
        sections.push(wrap_text(&description, max_width).join("\n"));
    }
    let groups: Vec<String> = entries
        .iter()
        .filter_map(|e| match e {
            Entry::Group { name, path } => Some(row(name, &d.group_settings(path).description)),
            _ => None,
        })
        .collect();
    if !groups.is_empty() {
        sections.push(format!("Groups:\n{}", groups.join("\n")));
    }
    let commands: Vec<String> = entries
        .iter()
        .filter_map(|e| match e {
            Entry::Command { name, path } => Some(row(name, descriptions.get(path).map(String::as_str).unwrap_or(""))),
            _ => None,
        })
        .collect();
    if !commands.is_empty() {
        sections.push(format!("Commands:\n{}", commands.join("\n")));
    }
    if entries.is_empty() {
        sections.push(format!("No commands found in {}", dir.display()));
    }
    sections.push(format!("Global:\n{}", global.iter().map(|(l, t)| row(l, t)).collect::<Vec<_>>().join("\n")));
    sections.push(format!("Run '{prefix} <command> --help' for a command's options."));
    sections.join("\n\n") + "\n"
}

fn clean(text: &str) -> String {
    text.replace(['\t', '\n'], " ")
}

/// Completion records for the words typed so far (spec section 12).
fn completion_data(d: &Dispatcher, words: &[String]) -> String {
    let (dir, path, command) = d.walk(words);
    let mut out = String::from("#clyops-completion 1\n");
    if let Some(command) = command {
        // Past a command: its own records, after the words that led to it.
        let rest = &words[path.len()..];
        let mut skip = path.len();
        let mut body = String::new();
        if classify(&command) != Kind::Other {
            let args: Vec<String> =
                ["--bash-completion".to_string(), "--".to_string()].into_iter().chain(rest.iter().cloned()).collect();
            let data = probe(&command, &args).unwrap_or_default();
            if data.starts_with("#clyops-completion 1") {
                for line in data.lines().skip(1) {
                    // A nested dispatcher adds its own skip to ours.
                    match line.strip_prefix("skip\t").and_then(|n| n.parse::<usize>().ok()) {
                        Some(n) => skip += n,
                        None => body.push_str(&format!("{line}\n")),
                    }
                }
            }
        }
        out.push_str(&format!("skip\t{skip}\n{body}"));
        return out;
    }
    if path.len() < words.len() && !words[path.len()].starts_with('-') {
        // An unknown subcommand: nothing to offer.
        return out;
    }
    out.push_str(&format!("skip\t{}\n", path.len()));
    let entries = d.entries(&dir);
    let commands: Vec<PathBuf> =
        entries.iter().filter_map(|e| if let Entry::Command { path, .. } = e { Some(path.clone()) } else { None }).collect();
    let descriptions = describe(&commands);
    for entry in &entries {
        let description = match entry {
            Entry::Command { path, .. } => descriptions.get(path).cloned().unwrap_or_default(),
            Entry::Group { path, .. } => d.group_settings(path).description,
        };
        out.push_str(&format!("cmd\t{}\t{}\n", entry.name(), clean(&description)));
    }
    out.push_str("opt\t--help\t-h\tflag\tnone\t-\tShow this help message and exit\n");
    out.push_str("opt\t--completion\t-\tvalue\tchoice\tbash,zsh,fish\tPrint a completion script for bash, zsh or fish\n");
    out
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn exec(path: &Path, args: &[OsString]) -> ! {
    use std::os::unix::process::CommandExt;
    let err = Command::new(path).args(args).exec();
    die(126, &format!("Cannot run {}: {err}", path.display()))
}

#[cfg(not(unix))]
fn exec(path: &Path, args: &[OsString]) -> ! {
    match Command::new(path).args(args).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(err) => die(126, &format!("Cannot run {}: {err}", path.display())),
    }
}

/// Quote for bash and zsh.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Quote for fish.
fn fish_quote(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// The completion script for `shell`. The scripts call the program by the
/// name typed on the command line; with --root that name is an alias the
/// script cannot run, so it calls clyops-dispatch with the same options.
fn completion_script(d: &Dispatcher, shell: &str) -> Option<String> {
    let mut cli = Cli::new();
    cli.name(&d.prog);
    let script = cli.completion_script(shell)?;
    if d.definition.is_some() {
        return Some(script);
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("clyops-dispatch"));
    let parts = [
        exe.to_string_lossy().into_owned(),
        "--root".into(),
        d.root.to_string_lossy().into_owned(),
        "--name".into(),
        d.prog.clone(),
    ];
    let (typed, quote): (&str, fn(&str) -> String) = match shell {
        "bash" => ("\"${COMP_WORDS[0]}\" --bash-completion", sh_quote),
        "zsh" => ("\"${words[1]}\" --bash-completion", sh_quote),
        _ => ("command $tokens[1] --bash-completion", fish_quote),
    };
    let invocation = parts.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" ");
    assert!(script.contains(typed), "completion template no longer calls `{typed}`");
    Some(script.replace(typed, &format!("{invocation} --bash-completion")))
}

fn dispatch(d: Dispatcher, args: &[OsString]) -> ! {
    let words: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();

    // Requests the dispatcher answers itself come before any subcommand.
    match words.first().map(String::as_str) {
        Some("--bash-completion") => {
            let rest = if words.get(1).map(String::as_str) == Some("--") { &words[2..] } else { &words[1..] };
            print!("{}", completion_data(&d, rest));
            std::process::exit(0)
        }
        Some("--completion") => {
            let shell = words.get(1).map(String::as_str).unwrap_or("");
            match completion_script(&d, shell) {
                Some(script) => {
                    print!("{script}");
                    std::process::exit(0)
                }
                None => die(1, &format!("Unknown shell '{shell}' (expected bash, zsh or fish)")),
            }
        }
        _ => {}
    }

    let (dir, path, command) = d.walk(&words);
    if let Some(command) = command {
        exec(&command, &args[path.len()..]);
    }
    match words.get(path.len()).map(String::as_str) {
        None | Some("--help") | Some("-h") => {
            print!("{}", usage(&d, &dir, &path));
            std::process::exit(0)
        }
        Some("--list") => {
            for entry in d.entries(&dir) {
                println!("{}", entry.name());
            }
            std::process::exit(0)
        }
        Some(word) => {
            let what = if word.starts_with('-') { "option" } else { "command" };
            clyops::error(&format!("Unknown {what}: {word}"));
            eprint!("{}", usage(&d, &dir, &path));
            std::process::exit(1)
        }
    }
}

#[rustfmt::skip]
fn main() {
    let args: Vec<OsString> = std::env::args_os().collect();
    // `--root DIR [--name NAME]` before the subcommand: no definition file.
    let (mut root, mut name, mut i) = (None, None, 1);
    while let Some(arg) = args.get(i).map(|a| a.to_string_lossy().into_owned()) {
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (arg.clone(), None),
        };
        if key != "--root" && key != "--name" {
            break;
        }
        let value = match inline {
            Some(v) => v,
            None => {
                i += 1;
                args.get(i).map(|a| a.to_string_lossy().into_owned()).unwrap_or_else(|| die(1, &format!("Option {key} requires an argument")))
            }
        };
        if key == "--root" { root = Some(PathBuf::from(value)) } else { name = Some(value) }
        i += 1;
    }
    match (root, name) {
        (Some(root), name) => dispatch(Dispatcher::from_root(&root, name), &args[i..]),
        (None, Some(_)) => die(1, "--name only applies with --root"),
        (None, None) => {}
    }
    // Run from a definition's shebang (or as `clyops-dispatch DEFINITION ...`).
    if let Some(first) = args.get(1) {
        if Path::new(first).is_file() {
            dispatch(Dispatcher::load(Path::new(first)), &args[2..]);
        }
    }

    let mut cli = Cli::new();
    cli.name("clyops-dispatch");
    cli.description("Turn a directory of tools into one command with nested subcommands, help and shell completion. Start a definition file with '#!/usr/bin/env clyops-dispatch' and run it, or alias a name to 'clyops-dispatch --root DIR --name NAME': executables in the directory become subcommands named after their basename, and subdirectories become groups.");
    cli.epilog("Definition file keys (one 'key: value' per line):\n  description  shown at the top of the help\n  dir          tools directory, relative to the definition (default: its own directory)\n  ignore       comma-separated names to leave out\n\nA group directory (and the --root directory) can hold a .clyops file with 'description' and 'ignore'.\n\nExample:\n  alias mytool='clyops-dispatch --root ~/mytool/scripts --name mytool'");
    cli.arg("definition", "Dispatcher definition file (or use --root)", "", "file:exists");
    cli.arg_variadic("args", "Subcommand and its arguments", "");
    cli.opt("ROOT", "root", "", "optional", "Tools directory, instead of a definition file").rule("dir:exists");
    cli.opt("NAME", "name", "", "optional", "Program name for help and completion with --root (default: the directory name)");
    let values = cli.run();
    // Reached only when the definition was not a regular file.
    die(1, &format!("Not a dispatcher definition: {}", values.str("definition")));
}
