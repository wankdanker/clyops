#!/usr/bin/env python3
"""Validate --help-json-schema output against spec/schema.json.

    python3 tools/check-schema.py                 # the conformance golden (every implementation matches it)
    python3 tools/check-schema.py out.json ...    # any other captured outputs

Needs the `jsonschema` package (pip install jsonschema).
"""
import json
import os
import sys

import jsonschema

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    with open(os.path.join(ROOT, "spec", "schema.json")) as fh:
        schema = json.load(fh)
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    golden = os.path.join(ROOT, "spec", "conformance", "golden")
    paths = sys.argv[1:] or [os.path.join(golden, "schema.json"), os.path.join(golden, "tasks-schema.json")]
    failed = 0
    for path in paths:
        with open(path) as fh:
            errors = sorted(validator.iter_errors(json.load(fh)), key=lambda e: list(e.absolute_path))
        for err in errors:
            print(f"{path}: {'/'.join(map(str, err.absolute_path)) or '.'}: {err.message}")
        failed += bool(errors)
        if not errors:
            print(f"{os.path.relpath(path, ROOT)}: valid")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
