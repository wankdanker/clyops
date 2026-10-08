//! Runs the built clyops-dispatch against fixture trees.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_clyops-dispatch");

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Tree {
        let root = std::env::temp_dir().join(format!("cdtest-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Tree { root }
    }

    fn file(&self, rel: &str, content: &str, executable: bool) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 })).unwrap();
        path
    }

    /// A fake clyops tool: answers --help-json-schema and --bash-completion,
    /// logs each probe, and otherwise prints its arguments.
    fn tool(&self, rel: &str, description: &str) -> PathBuf {
        let log = self.root.join("probes.log");
        self.file(
            rel,
            &format!(
                "#!/bin/sh\ncase \"$1\" in\n  --help-json-schema) echo {name} >> {log}; printf '%s\\n' '{{\"clyops\": 1, \"description\": \"{description}\\nmore\"}}' ;;\n  --bash-completion) printf '#clyops-completion 1\\nopt\\t--fast\\t-f\\tflag\\tnone\\t-\\tGo fast\\n' ;;\n  *) echo \"{name} $*\"; exit 3 ;;\nesac\n",
                name = Path::new(rel).file_name().unwrap().to_string_lossy(),
                log = log.display(),
            ),
            true,
        )
    }

    fn probes(&self) -> String {
        fs::read_to_string(self.root.join("probes.log")).unwrap_or_default()
    }

    fn run(&self, definition: &str, args: &[&str]) -> Output {
        Command::new(BIN)
            .arg(self.root.join(definition))
            .args(args)
            .env("XDG_CACHE_HOME", self.root.join("cache"))
            .env_remove("CLYOPS_MAX_WIDTH")
            .output()
            .unwrap()
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn standard(name: &str) -> Tree {
    let t = Tree::new(name);
    t.file("tools", "#!/usr/bin/env clyops-dispatch\n# comment\ndescription: Test tools\nignore: lib, skipme\n", true);
    t.tool("check.sh", "Run the checks");
    t.tool("media/to-pcm.sh", "Convert media to PCM");
    t.tool("media/fp/index", "Index fingerprints");
    t.file("media/.clyops", "description: Media tools\n", false);
    t.file("media/legacy", "#!/bin/sh\necho legacy \"$@\"\n", true);
    t.file("notes.txt", "not executable", false);
    t.file(".hidden", "#!/bin/sh\n", true);
    t.file("skipme.sh", "#!/bin/sh\n", true);
    t.tool("lib/helper.sh", "Helper");
    t
}

#[test]
fn lists_groups_and_commands_with_descriptions() {
    let t = standard("std1");
    let out = t.run("tools", &[]);
    assert!(out.status.success(), "{}", stderr(&out));
    let text = stdout(&out);
    assert!(text.starts_with("Usage: tools <command> [args...]\n\nTest tools\n\nGroups:\n  media"), "{text}");
    assert!(text.contains("  media                         Media tools\n"), "{text}");
    assert!(text.contains("Commands:\n  check                         Run the checks\n"), "{text}");
    for hidden in ["notes", "hidden", "skipme", "lib", "helper", "tools  "] {
        assert!(!text.contains(hidden), "{hidden} should not be listed:\n{text}");
    }
    assert!(text.ends_with("Run 'tools <command> --help' for a command's options.\n"), "{text}");
}

#[test]
fn lists_a_group() {
    let t = standard("std2");
    let text = stdout(&t.run("tools", &["media", "--help"]));
    assert!(text.starts_with("Usage: tools media <command> [args...]\n\nMedia tools\n\nGroups:\n  fp"), "{text}");
    assert!(text.contains("  legacy\n"), "{text}");
    assert!(text.contains("  to-pcm                        Convert media to PCM\n"), "{text}");
    assert_eq!(stdout(&t.run("tools", &["media"])), text);
    assert_eq!(stdout(&t.run("tools", &["media", "--list"])), "fp\nlegacy\nto-pcm\n");
}

#[test]
fn runs_nested_commands_with_their_arguments_and_exit_code() {
    let t = standard("std3");
    let out = t.run("tools", &["media", "fp", "index", "a", "--x", "b c"]);
    assert_eq!(stdout(&out), "index a --x b c\n");
    assert_eq!(out.status.code(), Some(3));
    let out = t.run("tools", &["media", "legacy", "--help"]);
    assert_eq!(stdout(&out), "legacy --help\n");
    assert!(out.status.success());
}

#[test]
fn reports_unknown_commands_and_options() {
    let t = standard("std4");
    let out = t.run("tools", &["media", "nope"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("[error] Unknown command: nope\nUsage: tools media <command>"), "{}", stderr(&out));
    let out = t.run("tools", &["--bogus"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("Unknown option: --bogus"));
}

#[test]
fn completion_data_follows_the_words() {
    let t = standard("std5");
    let root = stdout(&t.run("tools", &["--bash-completion", "--"]));
    assert!(
        root.starts_with("#clyops-completion 1\nskip\t0\ncmd\tcheck\tRun the checks\ncmd\tmedia\tMedia tools\nopt\t--help"),
        "{root}"
    );

    let group = stdout(&t.run("tools", &["--bash-completion", "--", "media"]));
    assert!(group.contains("skip\t1\ncmd\tfp\t\ncmd\tlegacy\t\ncmd\tto-pcm\tConvert media to PCM\n"), "{group}");

    let leaf = stdout(&t.run("tools", &["--bash-completion", "--", "media", "fp", "index", "x"]));
    assert_eq!(leaf, "#clyops-completion 1\nskip\t3\nopt\t--fast\t-f\tflag\tnone\t-\tGo fast\n");

    let plain = stdout(&t.run("tools", &["--bash-completion", "--", "media", "legacy"]));
    assert_eq!(plain, "#clyops-completion 1\nskip\t2\n");

    let unknown = stdout(&t.run("tools", &["--bash-completion", "--", "nope", "x"]));
    assert_eq!(unknown, "#clyops-completion 1\n");
}

#[test]
fn nested_dispatchers_add_their_skip() {
    let t = Tree::new("nested");
    t.file("tools", "description: Outer\n", true);
    t.file("sub/inner", &format!("#!{BIN}\ndescription: Inner\ndir: ../inner-tools\n"), true);
    t.tool("inner-tools/run", "Run it");
    assert!(
        stdout(&t.run("tools", &["sub"])).contains("  inner                         Inner\n"),
        "nested dispatcher described from its definition"
    );
    let data = stdout(&t.run("tools", &["--bash-completion", "--", "sub", "inner", "run"]));
    assert_eq!(data, "#clyops-completion 1\nskip\t3\nopt\t--fast\t-f\tflag\tnone\t-\tGo fast\n");
    let out = t.run("tools", &["sub", "inner", "run", "z"]);
    assert_eq!(stdout(&out), "run z\n");
}

#[test]
fn caches_descriptions_until_a_tool_changes() {
    let t = standard("std6");
    t.run("tools", &[]);
    assert_eq!(t.probes(), "check.sh\n");
    t.run("tools", &[]);
    assert_eq!(t.probes(), "check.sh\n", "second listing comes from the cache");
    std::thread::sleep(std::time::Duration::from_millis(20));
    t.tool("check.sh", "Run the checks, changed");
    let text = stdout(&t.run("tools", &[]));
    assert_eq!(t.probes().lines().count(), 2);
    assert!(text.contains("Run the checks, changed"), "{text}");
}

#[test]
fn only_probes_files_that_mention_clyops() {
    let t = Tree::new("probe");
    t.file("tools", "description: T\n", true);
    let marker = t.root.join("ran");
    t.file("danger", &format!("#!/bin/sh\ntouch {}\n", marker.display()), true);
    // Mentioning clyops is not enough; the file must load a clyops library.
    t.file("mentions", &format!("#!/bin/sh\n# see clyops docs\ntouch {}\n", marker.display()), true);
    let text = stdout(&t.run("tools", &[]));
    assert!(text.contains("  danger\n") && text.contains("  mentions\n"), "{text}");
    assert!(!marker.exists(), "a non-clyops executable must not be run to list it");
}

#[test]
fn groups_shadow_commands_and_dir_moves_the_root() {
    let t = Tree::new("shadow");
    t.file("bin/tools", "description: T\ndir: ../scripts\n", true);
    t.tool("scripts/media.sh", "A command");
    t.tool("scripts/media/x", "X");
    assert_eq!(stdout(&t.run("bin/tools", &["--list"])), "media\n");
    assert_eq!(stdout(&t.run("bin/tools", &["media", "x"])), "x \n");
}

#[test]
fn prints_completion_scripts_named_after_the_dispatcher() {
    let t = standard("std7");
    let bash = stdout(&t.run("tools", &["--completion", "bash"]));
    assert!(bash.ends_with("complete -F _clyops_tools tools\n"), "{bash}");
    let out = t.run("tools", &["--completion", "tcsh"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("Unknown shell 'tcsh' (expected bash, zsh or fish)"));
}

#[test]
fn rejects_bad_definitions() {
    let t = Tree::new("bad");
    t.file("tools", "descripton: typo\n", true);
    let out = t.run("tools", &[]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("unknown key 'descripton'"), "{}", stderr(&out));

    let out = Command::new(BIN).arg("/nonexistent/tools").output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("file does not exist"), "{}", stderr(&out));
}

fn run_root(t: &Tree, args: &[&str]) -> Output {
    Command::new(BIN).args(args).env("XDG_CACHE_HOME", t.root.join("cache")).env_remove("CLYOPS_MAX_WIDTH").output().unwrap()
}

#[test]
fn root_mode_works_without_a_definition_file() {
    let t = Tree::new("root");
    t.file("scripts/.clyops", "description: Root tools\nignore: lib\n", false);
    t.tool("scripts/check.sh", "Run the checks");
    t.tool("scripts/media/to-pcm", "Convert");
    t.tool("scripts/lib/helper", "Helper");
    let root = t.root.join("scripts");
    let root = root.to_str().unwrap();

    let text = stdout(&run_root(&t, &["--root", root, "--name", "whspr"]));
    assert!(text.starts_with("Usage: whspr <command> [args...]\n\nRoot tools\n\nGroups:\n  media"), "{text}");
    assert!(text.contains("  check                         Run the checks\n") && !text.contains("helper"), "{text}");

    // Without --name, the directory names the program; --root=DIR works too.
    let text = stdout(&run_root(&t, &[&format!("--root={root}"), "media"]));
    assert!(text.starts_with("Usage: scripts media <command>"), "{text}");

    let out = run_root(&t, &["--root", root, "media", "to-pcm", "a"]);
    assert_eq!((stdout(&out).as_str(), out.status.code()), ("to-pcm a\n", Some(3)));

    let data = stdout(&run_root(&t, &["--root", root, "--name", "whspr", "--bash-completion", "--", "media"]));
    assert!(data.starts_with("#clyops-completion 1\nskip\t1\ncmd\tto-pcm\tConvert\n"), "{data}");
}

#[test]
fn root_mode_completion_scripts_call_the_dispatcher_directly() {
    let t = Tree::new("rootcomp");
    t.tool("it's/x", "X");
    let root = t.root.join("it's");
    let root = root.to_str().unwrap();
    let real = std::fs::canonicalize(BIN).unwrap();

    let bash = stdout(&run_root(&t, &["--root", root, "--name", "whspr", "--completion", "bash"]));
    let call = format!("'{}' '--root' '{}' '--name' 'whspr' --bash-completion", real.display(), root.replace('\'', "'\\''"));
    assert!(bash.contains(&call), "{bash}");
    assert!(bash.ends_with("complete -F _clyops_whspr whspr\n"));

    let fish = stdout(&run_root(&t, &["--root", root, "--name", "whspr", "--completion", "fish"]));
    assert!(fish.contains(&format!("'--root' '{}' '--name' 'whspr' --bash-completion", root.replace('\'', "\\'"))), "{fish}");

    let zsh = stdout(&run_root(&t, &["--root", root, "--name", "whspr", "--completion", "zsh"]));
    assert!(zsh.contains("'--name' 'whspr' --bash-completion") && !zsh.contains("\"${words[1]}\" --bash-completion"), "{zsh}");
}

#[test]
fn root_mode_errors() {
    let t = Tree::new("rooterr");
    let out = run_root(&t, &["--name", "x"]);
    assert!(stderr(&out).contains("--name only applies with --root") && out.status.code() == Some(1));
    let out = run_root(&t, &["--root"]);
    assert!(stderr(&out).contains("Option --root requires an argument") && out.status.code() == Some(1));
    let out = run_root(&t, &["--root", "/nonexistent-dir"]);
    assert!(stderr(&out).contains("--root /nonexistent-dir") && out.status.code() == Some(1));
}
