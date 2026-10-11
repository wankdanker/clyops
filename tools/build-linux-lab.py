#!/usr/bin/env python3
"""Build the browser Linux guest and a v86 filesystem from normal Alpine packages."""
import hashlib
import http.client
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import zstandard

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = ROOT / "tools/linux-lab"
CACHE = ROOT / ".docs-tools/linux-lab"
OUTPUT = ROOT / "docs/_generated/linux-lab"
STORE = ROOT / "docs/_generated/linux-runtime"
BIOS_REVISION = "94faf3d6b19ecabc53a4010aaa24252fa6a162e2"
BIOS = {
    "seabios.bin": "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98",
    "vgabios.bin": "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880",
}


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def download_verified(url, cached, checksum):
    """Retry transient failures; cache only complete, checksum-verified files."""
    if cached.exists():
        data = cached.read_bytes()
        if hashlib.sha256(data).hexdigest() == checksum:
            return data
        print(f"Discarding invalid cached {cached.name}", flush=True)
        cached.unlink()
    attempts = 4
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read()
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code not in (408, 429) and error.code < 500:
                raise
            if attempt == attempts - 1:
                raise RuntimeError(f"Could not download {cached.name} after {attempts} attempts") from error
            delay = 2 ** attempt
            print(f"Download failed for {cached.name}: {error}; retrying in {delay}s ({attempt + 2}/{attempts})", flush=True)
            time.sleep(delay)
            continue
        if hashlib.sha256(data).hexdigest() != checksum:
            raise ValueError(f"Invalid checksum for {cached.name}")
        partial = cached.with_suffix(cached.suffix + ".partial")
        try:
            partial.write_bytes(data)
            partial.replace(cached)
        finally:
            partial.unlink(missing_ok=True)
        return data


def guest_tar():
    digest = hashlib.sha256()
    for name in ("Dockerfile", "init.sh", "login.sh", "bashrc", "upload-server.py"):
        digest.update(name.encode() + (CONTEXT / name).read_bytes())
    key = digest.hexdigest()[:20]
    cached = CACHE / (key + ".tar")
    if not cached.exists():
        image = "clyops-linux-lab:" + key
        subprocess.run(["docker", "build", "--platform", "linux/386", "--tag", image, str(CONTEXT)], cwd=ROOT, check=True)
        container = run("docker", "create", "--platform", "linux/386", image)
        partial = cached.with_suffix(".partial")
        try:
            subprocess.run(["docker", "export", "--output", str(partial), container], check=True)
            partial.replace(cached)
        finally:
            partial.unlink(missing_ok=True)
            run("docker", "rm", container)
    return cached


def build():
    CACHE.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(OUTPUT, ignore_errors=True)
    shutil.rmtree(STORE, ignore_errors=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    STORE.mkdir(parents=True, exist_ok=True)
    blobs = STORE
    tree = []
    total = 0
    compressor = zstandard.ZstdCompressor(level=10)
    compressed = {}
    packages = []

    def directory(parts):
        entries = tree
        for part in parts:
            node = next((node for node in entries if node[0] == part), None)
            if node is None:
                node = [part, 0, 0, stat.S_IFDIR | 0o755, 0, 0, []]
                entries.append(node)
            entries = node[6]
        return entries

    def add(name, mode, data=None, link=None):
        nonlocal total
        parts = PurePosixPath(name.lstrip("/")).parts
        if not parts or name == ".dockerenv":
            return
        entries = directory(parts[:-1])
        if stat.S_ISDIR(mode):
            directory(parts)
            return
        size = len(data) if data is not None else len(link or "")
        total += size
        if data is not None:
            digest = hashlib.sha256(data).hexdigest()
            filename = compressed.get(digest)
            if filename is None:
                packed = compressor.compress(data)
                filename = hashlib.sha256(packed).hexdigest() + ".bin.zst"
                (blobs / filename).write_bytes(packed)
                compressed[digest] = filename
            target = filename
        else:
            target = link
        entries[:] = [node for node in entries if node[0] != parts[-1]]
        entries.append([parts[-1], size, 0, mode, 0, 0, target])

    with tarfile.open(guest_tar()) as archive:
        for member in archive:
            if member.isfile() or member.islnk():
                data = archive.extractfile(member).read()
                if member.name == "lib/apk/db/installed":
                    for record in data.decode().split("\n\n"):
                        fields = dict(line.split(":", 1) for line in record.splitlines() if ":" in line)
                        if "P" in fields:
                            packages.append({"name": fields["P"], "version": fields.get("V"), "license": fields.get("L"),
                                             "origin": fields.get("o"), "source_commit": fields.get("c"), "upstream": fields.get("U")})
                add(member.name, stat.S_IFREG | member.mode, data)
            elif member.issym():
                add(member.name, stat.S_IFLNK | member.mode, link=member.linkname)
            elif member.isdir():
                add(member.name, stat.S_IFDIR | member.mode)

    sources = [ROOT / "packages/bash/clyops.sh", *sorted((ROOT / "packages/python/src/clyops").glob("*.py")),
               ROOT / "examples/README.md", *sorted((ROOT / "examples/scripts").glob("*.*")),
               *sorted((ROOT / "examples/data").glob("*.*"))]
    for source in sources:
        add("workspace/" + source.relative_to(ROOT).as_posix(), stat.S_IFREG | (source.stat().st_mode & 0o777), source.read_bytes())
    (OUTPUT / "filesystem.json").write_text(json.dumps({"version": 3, "size": total, "fsroot": tree}, separators=(",", ":")))
    assets = {}

    def asset(name, data):
        filename = hashlib.sha256(data).hexdigest() + Path(name).suffix
        (STORE / filename).write_bytes(data)
        assets[name] = filename

    for name, checksum in BIOS.items():
        url = f"https://raw.githubusercontent.com/copy/v86/{BIOS_REVISION}/bios/{name}"
        asset(name, download_verified(url, CACHE / name, checksum))
    for name in ("v86.wasm", "v86-fallback.wasm"):
        asset(name, (ROOT / "node_modules/v86/build" / name).read_bytes())
    shutil.copyfile(ROOT / "node_modules/v86/build/libv86.mjs", OUTPUT / "libv86.mjs")
    (OUTPUT / "runtime.json").write_text(json.dumps(assets))
    shutil.copyfile(ROOT / "node_modules/v86/LICENSE", OUTPUT / "v86-LICENSE.txt")
    (OUTPUT / "packages.json").write_text(json.dumps(packages, indent=2))
    print(f"Linux lab built: {total / 1024 / 1024:.1f} MiB of guest files, loaded on demand.")


if __name__ == "__main__":
    build()
