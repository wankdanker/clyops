#!/usr/bin/env python3
"""Merge a checked site with immutable snapshots, then commit it to docs-pages.

Only invoked by the authorized GitHub Actions deployment job. This branch is
storage for Pages output; source branches and release tags are never rewritten.
"""
import argparse
import io
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from html import escape
from pathlib import Path


def merge(source, destination, tag, prefix):
    if tag:
        if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?", tag):
            raise ValueError("Invalid documentation release tag")
        if (destination / "versions" / tag).exists():
            raise ValueError(f"Documentation snapshot {tag} already exists; refusing to overwrite it")
    versions = destination / "versions"
    versions.mkdir(parents=True, exist_ok=True)
    # Hashed guest blobs are shared across immutable releases rather than copied
    # into every snapshot. Retain old blobs while any snapshot may reference them.
    runtime = source / "linux-runtime"
    if runtime.exists():
        stored = destination / "linux-runtime"
        stored.mkdir(exist_ok=True)
        for asset in runtime.iterdir():
            target = stored / asset.name
            if target.exists():
                if target.read_bytes() != asset.read_bytes():
                    raise ValueError(f"Immutable Linux asset changed: {asset.name}")
            else:
                shutil.copyfile(asset, target)
    if tag:
        snapshot = versions / tag
        shutil.copytree(source, snapshot, ignore=shutil.ignore_patterns("linux-runtime"))
    else:
        for entry in destination.iterdir():
            if entry.name in ("versions", "linux-runtime"):
                continue
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        for entry in source.iterdir():
            if entry.name == "linux-runtime":
                continue
            if entry.is_dir():
                shutil.copytree(entry, destination / entry.name)
            else:
                shutil.copyfile(entry, destination / entry.name)
    releases = sorted((p.name for p in versions.iterdir() if p.is_dir()), reverse=True,
                      key=lambda v: tuple(int(n) for n in v[1:].split("-")[0].split(".")))
    links = "".join(f'<li><a href="{escape(prefix.rstrip("/"))}/versions/{escape(tag)}/">{escape(tag)}</a></li>' for tag in releases)
    index = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
             '<title>clyops release documentation</title><main><h1>Release documentation</h1>'
             f'<a href="{escape(prefix.rstrip("/"))}/">Current development documentation</a><ul>{links}</ul></main></html>')
    (destination / "versions.html").write_text(index)
    if not (destination / "index.html").exists():
        (destination / "index.html").write_text(index)
    (destination / ".nojekyll").touch()


def git(*args, env=None, binary=False):
    result = subprocess.check_output(["git", *args], env=env, text=not binary)
    return result if binary else result.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--tag", default="")
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--push", action="store_true", help="Persist the merged output to docs-pages")
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    parent = ""
    if args.push:
        existing = git("ls-remote", "--heads", "origin", "docs-pages")
        if existing:
            git("fetch", "origin", "docs-pages")
            parent = git("rev-parse", "FETCH_HEAD")
            with tarfile.open(fileobj=io.BytesIO(git("archive", parent, binary=True))) as archive:
                archive.extractall(args.destination, filter="data")
    merge(args.source.resolve(), args.destination.resolve(), args.tag, args.prefix)
    env = dict(os.environ, DOCS_PATH_PREFIX=args.prefix)
    subprocess.run(["python3", "tools/check-doc-links.py", str(args.destination)], env=env, check=True)
    if args.push:
        with tempfile.TemporaryDirectory(prefix="clyops-doc-index-") as directory:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(directory) / "index"), GIT_WORK_TREE=str(args.destination.resolve()),
                       GIT_AUTHOR_NAME="github-actions[bot]", GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com",
                       GIT_COMMITTER_NAME="github-actions[bot]", GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com")
            git("add", "--all", env=env)
            tree = git("write-tree", env=env)
            parents = ["-p", parent] if parent else []
            commit = git("commit-tree", tree, *parents, "-m", f"docs: publish {args.tag or 'main'}", env=env)
            git("push", "origin", f"{commit}:refs/heads/docs-pages")


if __name__ == "__main__":
    main()
