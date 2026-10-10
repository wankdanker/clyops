#!/usr/bin/env python3
"""Protect release snapshots when refreshing the current documentation."""
import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("publish", Path(__file__).with_name("publish-docs.py"))
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublishingTests(unittest.TestCase):
    def test_git_publication_preserves_source_branch_and_snapshot_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote.git"
            repo = root / "repo"
            repo.mkdir()
            def git(*args, cwd=repo):
                return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()
            git("init", "--bare", str(remote))
            git("init", "-b", "main")
            git("config", "user.name", "Docs test")
            git("config", "user.email", "docs@example.test")
            git("remote", "add", "origin", str(remote))
            (repo / "tools").mkdir()
            for name in ["publish-docs.py", "check-doc-links.py"]:
                shutil.copyfile(Path(__file__).with_name(name), repo / "tools" / name)
            git("add", "tools")
            git("commit", "-m", "source")
            original = git("rev-parse", "HEAD")
            site = repo / "site"
            site.mkdir()
            (site / "index.html").write_text("<h1>Current</h1>")
            subprocess.run(["python3", "tools/publish-docs.py", "site", "deployed", "--prefix", "/clyops/", "--push"], cwd=repo, check=True, capture_output=True)
            # Simulate separate deployment runners; each restores stored output.
            shutil.rmtree(repo / "deployed")
            (site / "index.html").write_text("<h1>Release</h1>")
            subprocess.run(["python3", "tools/publish-docs.py", "site", "deployed", "--prefix", "/clyops/", "--tag", "v0.3.1", "--push"], cwd=repo, check=True, capture_output=True)
            shutil.rmtree(repo / "deployed")
            (site / "index.html").write_text("<h1>Updated current</h1>")
            subprocess.run(["python3", "tools/publish-docs.py", "site", "deployed", "--prefix", "/clyops/", "--push"], cwd=repo, check=True, capture_output=True)
            self.assertEqual(git("rev-parse", "HEAD"), original)
            self.assertEqual(git("show", "origin/docs-pages:versions/v0.3.1/index.html"), "<h1>Release</h1>")
            self.assertEqual(git("show", "origin/docs-pages:index.html"), "<h1>Updated current</h1>")

    def test_main_updates_preserve_release_and_stale_files_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            target = root / "published"
            source.mkdir()
            target.mkdir()
            (source / "index.html").write_text("release")
            publish.merge(source, target, "v0.3.1", "/clyops/")
            (target / "obsolete.html").write_text("old")
            (source / "index.html").write_text("development")
            publish.merge(source, target, "", "/clyops/")
            self.assertEqual((target / "index.html").read_text(), "development")
            self.assertEqual((target / "versions/v0.3.1/index.html").read_text(), "release")
            self.assertFalse((target / "obsolete.html").exists())
            self.assertIn('/clyops/versions/v0.3.1/', (target / "versions.html").read_text())
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                publish.merge(source, target, "v0.3.1", "/clyops/")

    def test_unsafe_tag_cannot_escape_the_version_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            with self.assertRaisesRegex(ValueError, "Invalid"):
                publish.merge(source, root / "published", "../../outside", "/clyops/")
            self.assertFalse((root / "outside").exists())


if __name__ == "__main__":
    unittest.main()
