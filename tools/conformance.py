#!/usr/bin/env python3
"""Run the shared conformance cases against one or more clyops implementations.

See spec/conformance/README.md for the case format.
"""
import argparse
import difflib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONF = os.path.join(ROOT, "spec", "conformance")


def substitute(obj, mapping):
    if isinstance(obj, str):
        for key, value in mapping.items():
            obj = obj.replace("{" + key + "}", value)
        return obj
    if isinstance(obj, list):
        return [substitute(x, mapping) for x in obj]
    if isinstance(obj, dict):
        return {k: substitute(v, mapping) for k, v in obj.items()}
    return obj


def subset_diff(expected, actual, path=""):
    """Return a list of mismatch descriptions for expected ⊆ actual."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path or '.'}: expected object, got {actual!r}"]
        out = []
        for key, value in expected.items():
            if key not in actual:
                out.append(f"{path}.{key}: missing")
            else:
                out += subset_diff(value, actual[key], f"{path}.{key}")
        return out
    # Booleans are not numbers here, even though Python thinks so.
    if isinstance(expected, bool) or isinstance(actual, bool):
        ok = type(expected) is type(actual) and expected == actual
    else:
        ok = expected == actual
    return [] if ok else [f"{path or '.'}: expected {expected!r}, got {actual!r}"]


def program(cmd, name):
    """The command for a demo program: the commands demo sits next to `demo`, named `tasks`."""
    if name == "demo":
        return cmd
    head, _, tail = cmd[-1].rpartition("demo")
    return cmd[:-1] + [head + name + tail]


def run_case(cmd, case, verbose):
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="clyops-"))
    try:
        mapping = {"tmp": tmp, "tmp_parent": os.path.dirname(tmp)}
        for d in case.get("dirs", []):
            os.makedirs(os.path.join(tmp, d), exist_ok=True)
        for rel, content in case.get("files", {}).items():
            full = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", newline="") as fh:
                fh.write(content)

        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
               "KEY": "secret", "DEMO_ROOT": tmp}
        for key, value in case.get("env", {}).items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value

        cwd = os.path.join(tmp, case.get("cwd", ""))
        proc = subprocess.run(cmd + case["args"], cwd=cwd, env=env, capture_output=True, text=True, timeout=60)
        expect = substitute(case["expect"], mapping)
        errors = []

        if proc.returncode != expect["exit"]:
            errors.append(f"exit: expected {expect['exit']}, got {proc.returncode}")

        if "stdout" in expect:
            want = expect["stdout"]
            if want.startswith("@"):
                golden = want[1:]
                with open(os.path.join(CONF, "golden", golden)) as fh:
                    want = substitute(fh.read(), mapping)
                if golden.endswith(".json"):
                    try:
                        if json.loads(proc.stdout) != json.loads(want):
                            errors.append("stdout JSON differs from golden " + golden)
                    except ValueError as exc:
                        errors.append(f"stdout is not JSON: {exc}")
                    want = None
            if want is not None and proc.stdout != want:
                diff = difflib.unified_diff(want.splitlines(True), proc.stdout.splitlines(True), "expected", "actual")
                errors.append("stdout differs:\n" + "".join(diff))

        for needle in expect.get("stderr", []):
            if needle not in proc.stderr:
                errors.append(f"stderr lacks {needle!r}")

        if "values" in expect or "sources" in expect:
            if proc.returncode == 0:
                try:
                    out = json.loads(proc.stdout)
                except ValueError as exc:
                    errors.append(f"stdout is not JSON: {exc}")
                    out = None
                if out is not None:
                    for key in ("values", "sources"):
                        if key in expect:
                            errors += subset_diff(expect[key], out.get(key), key)

        if errors and verbose:
            errors.append("--- stdout ---\n" + proc.stdout + "--- stderr ---\n" + proc.stderr)
        return errors
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("impls", nargs="*", help="implementation names from impls.json")
    parser.add_argument("--all", action="store_true", help="run every implementation")
    parser.add_argument("-k", dest="filter", default="", help="only cases whose name contains this text")
    parser.add_argument("-v", "--verbose", action="store_true", help="show output of failing cases")
    args = parser.parse_args()

    with open(os.path.join(CONF, "impls.json")) as fh:
        impls = json.load(fh)
    with open(os.path.join(CONF, "cases.json")) as fh:
        cases = [c for c in json.load(fh) if args.filter in c["name"]]

    names = list(impls) if args.all else args.impls
    if not names:
        parser.error("name at least one implementation, or pass --all")

    failed = 0
    for name in names:
        cmd = [os.path.join(ROOT, part) if part.startswith(("packages/", "./")) else part for part in impls[name]]
        bad = 0
        for case in cases:
            errors = run_case(program(cmd, case.get("program", "demo")), case, args.verbose)
            if errors:
                bad += 1
                print(f"FAIL [{name}] {case['name']}")
                for e in errors:
                    print("    " + e.replace("\n", "\n    "))
        print(f"{name}: {len(cases) - bad}/{len(cases)} passed")
        failed += bad
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
