#!/usr/bin/env python3
"""Compile/run the guide examples and inspect installed package type artifacts."""
import io
import json
import os
import posixpath
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "docs/examples"


def run(args, cwd=ROOT, env=None):
    try:
        return subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError as error:
        sys.stderr.write(error.stdout + error.stderr)
        raise


def exercise(command, env, cwd=ROOT):
    good = subprocess.run(command + ["--name", "Ada", "--count", "2", "--verbose"], check=False, cwd=cwd, env=env, capture_output=True, text=True)
    assert good.returncode == 0 and good.stdout.strip() == "Ada 2 true", (command, good.stdout, good.stderr)
    default = run(command, cwd=cwd, env=env)
    assert default.strip() == "World 1 false", (command, default)
    schema = json.loads(run(command + ["--help-json-schema"], cwd=cwd, env=env))
    assert schema["clyops"] == 1
    assert "--count" in run(command + ["--help"], cwd=cwd, env=env)
    bad = subprocess.run(command + ["--count", "invalid"], check=False, cwd=cwd, env=env, capture_output=True, text=True)
    assert bad.returncode == 1 and bad.stderr.strip(), (command, bad)
    print(f"Example passed: {Path(command[-1]).name}")


def main():
    with tempfile.TemporaryDirectory(prefix="clyops-doc-examples-") as directory:
        scratch = Path(directory)
        packed = scratch / "packages"
        packed.mkdir()
        run(["pnpm", "--filter", "!clyops-runner", "--filter", "!clyops-web", "-r", "pack", "--pack-destination", packed])
        artifacts = sorted(packed.glob("*.tgz"))
        assert len(artifacts) == 6, artifacts
        dependencies = {}
        for artifact in artifacts:
            with tarfile.open(artifact) as archive:
                manifest = json.load(archive.extractfile("package/package.json"))
                assert manifest.get("types") and "package/" + manifest["types"].removeprefix("./") in archive.getnames(), artifact
                assert "package/README.md" in archive.getnames(), artifact
                if manifest["name"] == "clyops-api":
                    assert "package/dist/ui/index.html" in archive.getnames(), artifact
                maps = [name for name in archive.getnames() if name.endswith(".d.ts.map")]
                assert maps, f"Missing declaration maps: {artifact}"
                for name in maps:
                    mapping = json.load(archive.extractfile(name))
                    for source in mapping["sources"]:
                        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), mapping.get("sourceRoot", ""), source))
                        assert target in archive.getnames(), f"Missing editor source {target} in {artifact}"
                dependencies[manifest["name"]] = "file:" + str(artifact)
        consumer = scratch / "consumer"
        consumer.mkdir()
        (consumer / "package.json").write_text(json.dumps({"private": True, "type": "module", "dependencies": dependencies, "pnpm": {"overrides": dependencies}}))
        run(["pnpm", "install", "--prefer-offline", "--ignore-scripts"], cwd=consumer)
        types = consumer / "node_modules/@types"
        types.mkdir(exist_ok=True)
        (types / "node").symlink_to(ROOT / "node_modules/@types/node", target_is_directory=True)
        for file in ["consumer.mts", "quickstart.cjs", "quickstart.ts"]:
            shutil.copyfile(EXAMPLES / file, consumer / file)
        (consumer / "tsconfig.json").write_text(json.dumps({"compilerOptions": {"target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": True, "skipLibCheck": True, "outDir": "compiled"}, "include": ["*.mts", "*.ts"]}))
        run([ROOT / "node_modules/.bin/tsc", "-p", consumer / "tsconfig.json"])
        env = dict(os.environ)
        exercise(["node", str(consumer / "quickstart.cjs")], env)
        exercise(["node", str(consumer / "compiled/quickstart.js")], env)
        # This also proves declarations for the adapters resolve in an installed consumer.
        print("All six packed Node packages retain types; consumer typing passed.")

        run([sys.executable, "-m", "build", "--wheel", "--no-isolation", "packages/python", "--outdir", packed])
        wheel = next(packed.glob("*.whl"))
        with zipfile.ZipFile(wheel) as archive:
            assert "clyops/py.typed" in archive.namelist()
        installed = scratch / "python"
        run([sys.executable, "-m", "pip", "install", "--no-deps", "--target", installed, wheel])
        env = dict(os.environ, PYTHONPATH=str(installed), MYPYPATH=str(installed))
        exercise([sys.executable, str(EXAMPLES / "quickstart.py")], env, cwd=scratch)
        run([sys.executable, "-m", "mypy", "--strict", "--follow-imports=silent", EXAMPLES / "consumer.py"], cwd=scratch, env=env)
        negative = scratch / "invalid-consumer.py"
        negative.write_text('from clyops import Cli\nCli().opt("X", "x", rule=123)\n')
        rejected = subprocess.run([sys.executable, "-m", "mypy", "--strict", "--follow-imports=silent", str(negative)], check=False, cwd=scratch, env=env, capture_output=True, text=True)
        assert rejected.returncode != 0 and "[arg-type]" in rejected.stdout, rejected.stdout + rejected.stderr
        print("Installed Python wheel includes py.typed; consumer typing passed.")

        env = dict(os.environ, RUBYLIB=str(ROOT / "packages/ruby/lib"), CLYOPS_LIBRARY=str(ROOT / "packages/bash/clyops.sh"))
        exercise(["ruby", str(EXAMPLES / "quickstart.rb")], env)
        gem = packed / "clyops.gem"
        run(["gem", "build", "clyops.gemspec", "--output", gem], cwd=ROOT / "packages/ruby")
        with tarfile.open(gem) as archive, tarfile.open(fileobj=io.BytesIO(archive.extractfile("data.tar.gz").read()), mode="r:gz") as files:
            assert files.extractfile("sig/clyops.rbs").read() == (ROOT / "packages/ruby/sig/clyops.rbs").read_bytes()
        print("Ruby gem includes validated RBS signatures.")
        exercise(["bash", str(EXAMPLES / "quickstart.sh")], env)
        run(["cargo", "build", "--locked", "--manifest-path", ROOT / "packages/rust/Cargo.toml"])
        run(["rustc", "--edition=2021", EXAMPLES / "quickstart.rs", "--extern", "clyops=" + str(ROOT / "packages/rust/target/debug/libclyops.rlib"), "-L", "dependency=" + str(ROOT / "packages/rust/target/debug/deps"), "-o", scratch / "rust-demo"])
        exercise([str(scratch / "rust-demo")], env)
        run(["go", "build", "-o", scratch / "go-demo", EXAMPLES / "quickstart.go"], cwd=ROOT / "packages/go")
        exercise([str(scratch / "go-demo")], env)
        run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", ROOT / "packages/c/include", EXAMPLES / "quickstart.c", ROOT / "packages/c/src/clyops.c", "-o", scratch / "c-demo"])
        exercise([str(scratch / "c-demo")], env)
        jar = ROOT / "packages/java/target" / f"clyops-{json.loads((ROOT / 'packages/js/package.json').read_text())['version']}.jar"
        run(["javac", "-cp", jar, "-d", scratch, EXAMPLES / "DocsDemo.java"])
        exercise(["java", "-cp", str(scratch) + os.pathsep + str(jar), "DocsDemo"], env)
        with zipfile.ZipFile(str(jar).replace(".jar", "-javadoc.jar")) as archive:
            assert "index.html" in archive.namelist()
        with zipfile.ZipFile(str(jar).replace(".jar", "-sources.jar")) as archive:
            assert "io/github/wankdanker/clyops/Cli.java" in archive.namelist()
        print("Java source and Javadoc JARs checked.")


if __name__ == "__main__":
    main()
