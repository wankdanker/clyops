#!/usr/bin/env python3
"""Exercise clone-and-run scripts, wrapper previews and the browser command runner."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "examples/scripts"
spec = importlib.util.spec_from_file_location("playground", ROOT / "tools/playground.py")
playground = importlib.util.module_from_spec(spec)
spec.loader.exec_module(playground)
playground.ROOT = ROOT


def run(name, *args, stdin=None, env=None, cwd=ROOT):
    clean = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "SYSTEMROOT")}
    return subprocess.run([str(SCRIPTS / name), *args], cwd=cwd, env=clean | (env or {}),
                          input=stdin, capture_output=True, text=True, timeout=10)


class Examples(unittest.TestCase):
    def test_help_schema_and_completion_work_without_optional_tools(self):
        for script in sorted(SCRIPTS.iterdir()):
            if script.suffix not in (".py", ".sh"):
                continue
            with self.subTest(script=script.name):
                self.assertTrue(os.access(script, os.X_OK))
                self.assertEqual(run(script.name, "--help").returncode, 0)
                result = run(script.name, "--help-json-schema")
                self.assertEqual(result.returncode, 0, result.stderr)
                schema = json.loads(result.stdout)
                self.assertEqual(schema["clyops"], 1)
                self.assertEqual(schema["script"], script.name)
                for shell in ("bash", "zsh", "fish"):
                    result = run(script.name, "--completion", shell)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(script.name, result.stdout)

    def test_python_tools_and_stdin(self):
        result = run("plan.py", "--env", "production", "--replicas", "3", "--tag", "one", "--tag", "two", cwd=Path(tempfile.gettempdir()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["tags"], ["one", "two"])
        self.assertEqual(run("plan.py", "--replicas", "99").returncode, 1)
        self.assertEqual(run("plan.py", "--email", "ops@example.com", "--webhook", "https://example.com").returncode, 1)
        rows = json.loads(run("report.py").stdout)
        self.assertEqual([row["average_ms"] for row in rows], [50, 160])
        self.assertEqual(json.loads(run("report.py", "--service", "worker").stdout)[0]["samples"], 3)
        result = run("json-format.py", "--style", "compact", "--sort", stdin='{"z":0,"a":false}')
        self.assertEqual(result.stdout, '{"a":false,"z":0}\n')
        self.assertEqual(run("json-format.py", stdin="broken").returncode, 1)

    def test_wrapper_previews_do_not_execute_and_real_arguments_stay_separate(self):
        with tempfile.TemporaryDirectory(prefix="clyops-example-") as directory:
            scratch = Path(directory)
            marker = scratch / "called"
            for name in ("curl", "ffmpeg", "ffprobe"):
                tool = scratch / name
                tool.write_text(f'#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\nPath({str(marker)!r}).write_text("called")\nprint(json.dumps(sys.argv[1:]))\n')
                tool.chmod(0o755)
            env = {"PATH": str(scratch) + os.pathsep + os.environ["PATH"]}
            source = scratch / "input file.json"
            source.write_text('{"hello":"world"}')
            output = scratch / "output file.mp4"
            preview = run("transcode.sh", str(source), str(output), env=env)
            self.assertEqual(preview.returncode, 0, preview.stderr)
            self.assertFalse(marker.exists())
            preview = run("upload.sh", str(source), "--url", "https://example.com/upload", "--token", "demo-secret", env=env)
            self.assertEqual(preview.returncode, 0, preview.stderr)
            self.assertNotIn("demo-secret", preview.stdout)
            self.assertIn("redacted", preview.stdout)
            self.assertFalse(marker.exists())
            result = run("transcode.sh", str(source), str(output), "--execute", "--quality", "18", env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            argv = json.loads(result.stdout)
            self.assertIn("-n", argv)
            self.assertEqual(argv[argv.index("-i") + 1], str(source))
            self.assertEqual(argv[-1], str(output))
            self.assertEqual(argv[argv.index("-crf") + 1], "18")
            result = run("upload.sh", str(source), "--url", "https://example.com/upload", "--token", "demo-secret", "--execute", env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            argv = json.loads(result.stdout)
            self.assertEqual(argv[argv.index("--upload-file") + 1], str(source))
            self.assertIn("Authorization: Bearer demo-secret", argv)
            self.assertEqual(run("upload.sh", str(source), "--url", "ftp://example.com", env=env).returncode, 1)
            result = run("media-info.sh", str(source), env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(str(source), json.loads(result.stdout))

    def test_browser_runner_runs_the_same_scripts_and_completion_protocol(self):
        result = playground.execute("plan.py --env production --replicas 4")
        self.assertEqual(result["code"], 0, result["stderr"])
        self.assertEqual(json.loads(result["stdout"])["replicas"], 4)
        self.assertEqual(playground.execute("plan.py --replicas 99")["code"], 1)
        self.assertEqual(playground.complete("plan.py --en"), ["--env"])
        self.assertEqual(playground.complete("plan.py --env pr"), ["production"])
        self.assertEqual(playground.execute("json-format.py --style compact", '{"a":1}')["stdout"], '{"a":1}\n')
        self.assertIn("set_description", playground.execute("cat examples/scripts/plan.py")["stdout"])
        self.assertEqual(playground.execute("cat ../outside")["code"], 1)
        self.assertEqual(playground.execute("bash transcode.sh")["code"], 1)
        self.assertTrue(playground.execute("clear")["clear"])


if __name__ == "__main__":
    unittest.main()
