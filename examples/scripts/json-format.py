#!/usr/bin/env python3
# clyops-tool
"""Format a document from a file or stdin; no pip dependencies."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/python/src"))
from clyops import Cli, die

cli = Cli(name="json-format.py")
cli.set_description("Validate and format a JSON document from stdin or a file.")
cli.opt("INPUT", "input", "i", "optional", "Read a file instead of stdin", "Input", "file:readable")
cli.opt("STYLE", "style", "s", "pretty", "Whitespace style", "Output", "choice:pretty,compact")
cli.opt("INDENT", "indent", "", "2", "Spaces per indentation level", "Output", "int:1-8")
cli.opt("SORT", "sort", "", "flag", "Sort object keys", "Output")
cli.set_effects("read-only")
cli.set_stdin("JSON document (when --input is omitted)", "application/json")
cli.set_stdout("Formatted document", "application/json")
args = cli.run()
try:
    if args.INPUT:
        with open(args.INPUT, encoding="utf-8") as file:
            value = json.load(file)
    else:
        value = json.load(sys.stdin)
    print(json.dumps(value, sort_keys=args.SORT, ensure_ascii=False,
                     indent=args.INDENT if args.STYLE == "pretty" else None,
                     separators=None if args.STYLE == "pretty" else (",", ":")))
except (OSError, ValueError) as error:
    die(1, f"Cannot format JSON: {error}")
