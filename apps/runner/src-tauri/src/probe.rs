//! Never run an arbitrary executable just to find out whether it is a tool.
#[path = "../../../dispatch/src/detection.rs"]
mod detection;

use std::path::Path;
use std::process::{Command, Output, Stdio};

pub fn is_tool(path: &Path) -> bool {
    std::fs::read(path)
        .map(|source| detection::uses_clyops(&source))
        .unwrap_or(false)
}

pub fn schema_output(path: &Path) -> Result<Output, String> {
    if !is_tool(path) {
        return Err("Not a clyops tool: no library loader or explicit clyops-tool header".into());
    }
    Command::new(path)
        .arg("--help-json-schema")
        .stdin(Stdio::null())
        .current_dir(path.parent().unwrap_or_else(|| Path::new(".")))
        .output()
        .map_err(|e| format!("Failed to execute script: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn never_executes_a_comment_or_documentation_mention() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "clyops-runner-probe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("ran");
        for (name, source) in [
            ("packaging.sh", "# see scripts/lib/clyops.sh"),
            ("docs.sh", "echo 'require(\"clyops\")'"),
            ("inline.sh", "# a clyops-tool is something else"),
        ] {
            let path = root.join(name);
            std::fs::write(
                &path,
                format!("#!/bin/sh\n{source}\ntouch '{}'\n", marker.display()),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(!is_tool(&path), "{name}");
            assert!(schema_output(&path)
                .unwrap_err()
                .starts_with("Not a clyops tool"));
            assert!(!marker.exists(), "{name} was executed");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn probes_explicitly_marked_wrappers() {
        use std::os::unix::fs::PermissionsExt;
        let path =
            std::env::temp_dir().join(format!("clyops-runner-marked-{}", std::process::id()));
        std::fs::write(
            &path,
            "#!/bin/sh\n# clyops-tool\nprintf '%s\\n' '{\"clyops\":1}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_tool(&path));
        let output = schema_output(&path).unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "{\"clyops\":1}\n"
        );
        std::fs::remove_file(path).unwrap();
    }
}
