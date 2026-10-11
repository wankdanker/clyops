#!/usr/bin/env python3
# clyops-tool
"""Summarize a CSV using only the Python standard library."""
import csv
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/python/src"))
from clyops import Cli, die

root = Path(__file__).resolve().parents[2]
cli = Cli(name="report.py", root=root)
cli.set_description("Summarize service latency from a CSV file.")
cli.opt("INPUT", "input", "i", "examples/data/latency.csv", "CSV with service and latency_ms columns", "Input", "file:readable")
cli.opt("FORMAT", "format", "f", "json", "Output format", "Output", "choice:json,table")
cli.opt("LIMIT", "limit", "l", "100", "Mark services above this latency (ms)", "Output", "float:0-10000")
cli.opt_array("SERVICE", "service", "s", "Only include these services", "Input", "string:1-80")
cli.set_effects("read-only")
cli.set_stdout("Latency report", "text/plain")
args = cli.run()
try:
    totals = {}
    with open(args.INPUT, newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            service = row["service"]
            if args.SERVICE and service not in args.SERVICE:
                continue
            value = float(row["latency_ms"])
            if not 0 <= value <= 10000:
                raise ValueError("latency_ms must be between 0 and 10000")
            totals.setdefault(service, []).append(value)
    report = [{"service": service, "samples": len(values), "average_ms": round(sum(values) / len(values), 2),
               "over_limit": sum(values) / len(values) > args.LIMIT} for service, values in sorted(totals.items())]
except (OSError, KeyError, ValueError, csv.Error) as error:
    die(1, f"Cannot read latency CSV: {error}")
if args.FORMAT == "json":
    print(json.dumps(report, indent=2))
else:
    print(f"{'SERVICE':<16} {'SAMPLES':>7} {'AVG MS':>10}  STATUS")
    for row in report:
        print(f"{row['service']:<16} {row['samples']:>7} {row['average_ms']:>10.2f}  {'slow' if row['over_limit'] else 'ok'}")
