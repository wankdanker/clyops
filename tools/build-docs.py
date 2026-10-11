#!/usr/bin/env python3
"""Build native API references, check examples, then render the Markdown site."""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "docs/_native"


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def main():
    os.chdir(ROOT)
    run(sys.executable, "tools/check-docs.py")
    shutil.rmtree(NATIVE, ignore_errors=True)
    NATIVE.mkdir(parents=True)
    run("pnpm", "exec", "typedoc", "--options", "docs/typedoc.json")
    env = dict(os.environ, PYTHONPATH=str(ROOT / "packages/python/src"))
    run(sys.executable, "-m", "pdoc", "clyops", "-o", str(NATIVE / "python"), env=env)
    env = dict(os.environ, RUSTDOCFLAGS="-D missing_docs -D rustdoc::broken_intra_doc_links")
    run("cargo", "doc", "--locked", "--no-deps", "--manifest-path", "packages/rust/Cargo.toml", env=env)
    shutil.copytree(ROOT / "packages/rust/target/doc", NATIVE / "rust")
    (NATIVE / "rust/index.html").write_text('<!doctype html><html lang="en"><meta charset="utf-8"><title>Rust API</title><a href="clyops/index.html">clyops Rust API</a></html>')
    run("mvn", "-B", "-q", "package", "-DskipTests", cwd=ROOT / "packages/java")
    shutil.copytree(ROOT / "packages/java/target/reports/apidocs", NATIVE / "java")
    run("doxygen", "docs/Doxyfile")
    run("ruby", "-ryard", "-e", "YARD::CLI::Yardoc.run(*ARGV)", "--", "--no-private", "--no-cache", "--output-dir", str(NATIVE / "ruby"), "lib/**/*.rb", cwd=ROOT / "packages/ruby")
    run("ruby", "tools/check-ruby-docs.rb")
    run("go", "run", "tools/docs-go/main.go")
    generated = ROOT / "docs/_generated"
    generated.mkdir(exist_ok=True)
    lines = ["---", "title: Bash API", "permalink: /reference/bash.html", "---", "# Bash API", "",
             "Generated from public function usage comments in `clyops.sh`.", ""]
    source = (ROOT / "packages/bash/clyops.sh").read_text().splitlines()
    for i, line in enumerate(source):
        match = re.match(r"^(clyops_\w+|info|warn|error|success|die)\(\)", line)
        if not match:
            continue
        start = i
        while start and source[start-1].startswith("#"):
            start -= 1
        comments = [s.removeprefix("#").strip() for s in source[start:i]]
        lines += [f"## `{match[1]}`", "", *comments, ""]
    (generated / "bash.md").write_text("\n".join(lines))
    run(sys.executable, "tools/check-doc-examples.py")
    run("node", "tools/build-home-demo.mjs")
    shutil.rmtree(ROOT / "_site", ignore_errors=True)
    run("pnpm", "exec", "eleventy", "--config=eleventy.config.mjs")
    run(sys.executable, "tools/check-doc-links.py", "_site")


if __name__ == "__main__":
    main()
