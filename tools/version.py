#!/usr/bin/env python3
"""One version for the whole monorepo.

    python3 tools/version.py              # print the version; fail if any manifest disagrees
    python3 tools/version.py --tag v0.1.0 # also fail unless the tag matches it
    python3 tools/version.py set 0.2.0    # rewrite every manifest
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

sys.path.insert(0, os.path.join(ROOT, "packages", "python", "src"))
from clyops import Cli  # noqa: E402

# (file, regex whose group 1 is the version). Edits replace only that span, so
# every file keeps its formatting.
TOP = r'(?m)^  "version": "([^"]+)"'
# JS/TS workspace versions live in their package.json; pnpm links local packages.
PUBLIC_WORKSPACES = ["packages/js", "packages/tools", "packages/jobs", "apps/mcp", "apps/api"]
FILES = [
    *[(f"{ws}/package.json", TOP) for ws in PUBLIC_WORKSPACES],
    ("packages/python/pyproject.toml", r'(?m)^version = "([^"]+)"'),
    ("packages/python/src/clyops/__init__.py", r'(?m)^__version__ = "([^"]+)"'),
    ("packages/rust/Cargo.toml", r'(?m)^version = "([^"]+)"'),
    ("packages/rust/Cargo.lock", r'name = "clyops"\nversion = "([^"]+)"'),
    ("packages/bash/clyops.sh", r'(?m)^CLYOPS_VERSION="([^"]+)"'),
    ("packages/c/include/clyops.h", r'(?m)^#define CLYOPS_VERSION "([^"]+)"'),
    ("packages/go/clyops.go", r'(?m)^const Version = "([^"]+)"'),
    ("packages/ruby/lib/clyops.rb", r'(?m)^  VERSION = "([^"]+)"'),
    ("packages/java/pom.xml", r'<artifactId>clyops</artifactId>\s*<version>([^<]+)</version>'),
    ("packages/java/src/main/java/io/github/wankdanker/clyops/Cli.java", r'VERSION = "([^"]+)"'),
    ("apps/runner/package.json", TOP),
    ("apps/runner/src-tauri/tauri.conf.json", TOP),
    ("apps/runner/src-tauri/Cargo.toml", r'(?m)^version = "([^"]+)"'),
    ("apps/runner/src-tauri/Cargo.lock", r'name = "clyops-runner"\nversion = "([^"]+)"'),
    ("apps/dispatch/Cargo.toml", r'(?m)^version = "([^"]+)"'),
    ("apps/dispatch/Cargo.toml", r'clyops = \{ path = "../../packages/rust", version = "([^"]+)" \}'),
    ("apps/dispatch/Cargo.lock", r'name = "clyops-dispatch"\nversion = "([^"]+)"'),
    ("apps/dispatch/Cargo.lock", r'name = "clyops"\nversion = "([^"]+)"'),
]


def read(rel):
    with open(os.path.join(ROOT, rel)) as fh:
        return fh.read()


# Workspaces pin each other exactly; every such pin is checked and rewritten.
JS_PIN = r'"clyops(?:-[a-z]+)?": "(\d[^"]*)"'
PINNED = [f"{ws}/package.json" for ws in PUBLIC_WORKSPACES]
PNPM_PIN = r'(?m)^      clyops(?:-[a-z]+)?:\n        specifier: (\d[^\n]*)'


def current():
    found = []
    for rel, pattern in FILES:
        m = re.search(pattern, read(rel))
        found.append((rel, m.group(1) if m else None))
    for rel in PINNED:
        found += [(rel, m.group(1)) for m in re.finditer(JS_PIN, read(rel))]
    found += [("pnpm-lock.yaml", m.group(1)) for m in re.finditer(PNPM_PIN, read("pnpm-lock.yaml"))]
    return found


def set_version(version):
    for rel, pattern in FILES:
        text = read(rel)
        m = re.search(pattern, text)
        with open(os.path.join(ROOT, rel), "w") as fh:
            fh.write(text[:m.start(1)] + version + text[m.end(1):])
    for rel in PINNED:
        text = re.sub(JS_PIN, lambda m: m.group(0).replace(m.group(1), version), read(rel))
        with open(os.path.join(ROOT, rel), "w") as fh:
            fh.write(text)
    text = re.sub(PNPM_PIN, lambda m: m.group(0).replace(m.group(1), version), read("pnpm-lock.yaml"))
    with open(os.path.join(ROOT, "pnpm-lock.yaml"), "w") as fh:
        fh.write(text)


def main():
    cli = Cli(name="version.py", root=ROOT)
    cli.set_description("Check or update the version across every monorepo manifest.")
    cli.set_epilog("Examples:\n  python3 tools/version.py\n  python3 tools/version.py --tag v0.1.0\n"
                   "  python3 tools/version.py set 0.2.0")
    cli.arg("command", "Action to perform", "check", "choice:check,set")
    cli.arg_variadic("version", "New semantic version for set", r"regex:^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\Z")
    cli.opt("TAG", "tag", default="optional", description="Release tag that must match the version")
    args = cli.run()
    if args.command == "set":
        if len(args.version) != 1:
            sys.exit("set requires exactly one semantic version")
        set_version(args.version[0])
    elif args.version:
        sys.exit("check does not accept a version argument")
    found = current()
    versions = {v for _, v in found}
    if len(versions) != 1 or None in versions:
        for rel, v in found:
            print(f"  {v}\t{rel}")
        sys.exit("versions disagree")
    version = versions.pop()
    if cli.is_set("tag") and args.TAG != f"v{version}":
        sys.exit(f"tag {args.TAG} does not match version {version} (expected v{version})")
    print(version)


if __name__ == "__main__":
    main()
