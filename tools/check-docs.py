#!/usr/bin/env python3
"""Check public docstrings/comments and Markdown example synchronization."""
import ast
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def python_docs():
    tree = ast.parse((ROOT / "packages/python/src/clyops/__init__.py").read_text())
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and not node.name.startswith("_"):
            assert ast.get_docstring(node), f"Python: undocumented {node.name}"
            if isinstance(node, ast.ClassDef):
                for method in node.body:
                    if isinstance(method, ast.FunctionDef) and (not method.name.startswith("_") or method.name == "__init__"):
                        assert ast.get_docstring(method), f"Python: undocumented {node.name}.{method.name}"


def comments():
    # Declarations in these public interfaces occupy their own lines. Native
    # generators additionally check links and render signatures/parameter types.
    for file in (ROOT / "packages/java/src/main/java/io/github/wankdanker/clyops").glob("*.java"):
        if file.name == "Completions.java":
            continue
        source = file.read_text()
        for match in re.finditer(r"(?m)^\s*public (?:static )?[^\n;=]+(?:\(|\{)", source):
            before = source[:match.start()].rstrip()
            # Annotations between a Javadoc and its declaration are permitted.
            before = re.sub(r"\s*@\w+(?:\([^\n]*\))?$", "", before).rstrip()
            assert before.endswith("*/"), f"Java: undocumented {match[0].strip()}"
    source = (ROOT / "packages/bash/clyops.sh").read_text()
    lines = source.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"^(?:clyops_\w+|info|warn|error|success|die)\(\)", line):
            assert i and lines[i-1].startswith("#"), f"Bash: undocumented {line}"
    # Ruby's actual public methods are checked by YARD and against shipped RBS.
    subprocess.run(["pnpm", "exec", "node", "tools/check-docs-ts.mjs"], cwd=ROOT, check=True)


def examples():
    for file in (ROOT / "docs/languages").glob("*.md"):
        for match in re.finditer(r"<!-- example: ([^\n]+) -->\n```[^\n]*\n(.*?)\n```", file.read_text(), re.DOTALL):
            path = ROOT / "docs/examples" / match[1]
            assert match[2] == path.read_text().rstrip(), f"Stale example in {file}; copy {path} into its marked fence"


if __name__ == "__main__":
    python_docs()
    comments()
    examples()
    print("Source documentation and Markdown examples checked.")
