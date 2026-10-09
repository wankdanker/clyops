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

# (file, regex whose group 1 is the version). Edits replace only that span, so
# every file keeps its formatting.
TOP = r'(?m)^  "version": "([^"]+)"'
LOCK_ROOT = r'"packages": \{\n    "": \{\n      "name": "[^"]+",\n      "version": "([^"]+)"'
# npm workspaces: their versions live in their package.json and the root lockfile.
NPM_WORKSPACES = ["packages/js", "packages/tools", "packages/jobs", "apps/api"]
LOCK_WS = r'"{}": \{{\n      "name": "[^"]+",\n      "version": "([^"]+)"'
FILES = [
    *[f for ws in NPM_WORKSPACES for f in ((f"{ws}/package.json", TOP), ("package-lock.json", LOCK_WS.format(ws)))],
    ("packages/python/pyproject.toml", r'(?m)^version = "([^"]+)"'),
    ("packages/python/src/clyops/__init__.py", r'(?m)^__version__ = "([^"]+)"'),
    ("packages/rust/Cargo.toml", r'(?m)^version = "([^"]+)"'),
    ("packages/bash/clyops.sh", r'(?m)^CLYOPS_VERSION="([^"]+)"'),
    ("packages/c/include/clyops.h", r'(?m)^#define CLYOPS_VERSION "([^"]+)"'),
    ("apps/runner/package.json", TOP),
    ("apps/runner/package-lock.json", TOP),
    ("apps/runner/package-lock.json", LOCK_ROOT),
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
NPM_PIN = r'"clyops(?:-[a-z]+)?": "(\d[^"]*)"'
PINNED = ["package-lock.json"] + [f"{ws}/package.json" for ws in NPM_WORKSPACES]


def current():
    found = []
    for rel, pattern in FILES:
        m = re.search(pattern, read(rel))
        found.append((rel, m.group(1) if m else None))
    for rel in PINNED:
        found += [(rel, m.group(1)) for m in re.finditer(NPM_PIN, read(rel))]
    return found


def set_version(version):
    for rel, pattern in FILES:
        text = read(rel)
        m = re.search(pattern, text)
        with open(os.path.join(ROOT, rel), "w") as fh:
            fh.write(text[:m.start(1)] + version + text[m.end(1):])
    for rel in PINNED:
        text = re.sub(NPM_PIN, lambda m: m.group(0).replace(m.group(1), version), read(rel))
        with open(os.path.join(ROOT, rel), "w") as fh:
            fh.write(text)


def main():
    args = sys.argv[1:]
    if args[:1] == ["set"] and len(args) == 2:
        if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", args[1]):
            sys.exit(f"not a semantic version: {args[1]}")
        set_version(args[1])
    found = current()
    versions = {v for _, v in found}
    if len(versions) != 1 or None in versions:
        for rel, v in found:
            print(f"  {v}\t{rel}")
        sys.exit("versions disagree")
    version = versions.pop()
    if args[:1] == ["--tag"]:
        if len(args) != 2 or args[1] != f"v{version}":
            sys.exit(f"tag {args[1:]} does not match version {version} (expected v{version})")
    print(version)


if __name__ == "__main__":
    main()
