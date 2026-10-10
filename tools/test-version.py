#!/usr/bin/env python3
"""Check release version edits against the shared pnpm lockfile, in scratch trees."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("version", REPO / "tools/version.py")
version = importlib.util.module_from_spec(spec)
spec.loader.exec_module(version)


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="clyops-version-")
        self.root = Path(self.scratch.name)
        files = {path for path, _ in version.FILES} | set(version.PINNED)
        files |= {"package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"}
        for path in files:
            destination = self.root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / path, destination)
        self.base_version = json.loads((self.root / "packages/js/package.json").read_text())["version"]
        self.original_root = version.ROOT
        version.ROOT = str(self.root)
        self.addCleanup(self.scratch.cleanup)
        self.addCleanup(setattr, version, "ROOT", self.original_root)

    def install_lockfile(self):
        return subprocess.run(
            ["pnpm", "install", "--lockfile-only", "--offline", "--frozen-lockfile", "--ignore-scripts",
             "--store-dir", str(self.root / ".pnpm-store")],
            cwd=self.root, capture_output=True, text=True, timeout=30,
        )

    def test_set_updates_manifests_and_lockfile_for_stable_and_prerelease(self):
        manager = json.loads((self.root / "package.json").read_text())["packageManager"]
        for new in ["0.3.0", "0.3.1-rc.1"]:
            with self.subTest(version=new):
                version.set_version(new)
                self.assertEqual({v for _, v in version.current()}, {new})
                result = self.install_lockfile()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(json.loads((self.root / "package.json").read_text())["packageManager"], manager)
                self.assertIn("version: link:../tools", (self.root / "pnpm-lock.yaml").read_text())

    def test_stale_lockfile_is_detected(self):
        lock = self.root / "pnpm-lock.yaml"
        lock.write_text(lock.read_text().replace(f"specifier: {self.base_version}", "specifier: 0.99.0", 1))
        self.assertEqual(len({v for _, v in version.current()}), 2)
        result = self.install_lockfile()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OUTDATED_LOCKFILE", result.stdout + result.stderr)

    def test_set_does_not_require_npm_lockfiles(self):
        self.assertFalse((self.root / "package-lock.json").exists())
        self.assertFalse((self.root / "apps/runner/package-lock.json").exists())
        version.set_version("0.4.0")
        self.assertEqual({v for _, v in version.current()}, {"0.4.0"})


if __name__ == "__main__":
    unittest.main()
