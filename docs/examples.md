---
title: Clone-and-run example tools
---
# Clone-and-run example tools

The repository includes a mixed [scripts directory](../examples/scripts) that
works immediately after cloning. The Python tools use only the standard library;
the Bash wrappers use the library beside them in the checkout. You do not need
to build clyops or install a Python package first.

```sh
git clone https://github.com/wankdanker/clyops.git
cd clyops
./examples/scripts/plan.py --help
./examples/scripts/plan.py --env production --replicas 3 --tag demo
./examples/scripts/report.py --format table
printf '{"z":2,"a":1}' | ./examples/scripts/json-format.py --sort
```

Use Python 3.9+ and Bash 4.3+. On macOS, use a current Bash from your package
manager; the system's Bash 3.2 is too old for the Bash library.

## Real wrappers, useful contracts

| Tool | Try it | Features |
| --- | --- | --- |
| `plan.py` | `--env production --replicas 3 --tag demo` | Choices, ranges, repeatable options, exclusive notification destinations |
| `report.py` | `--format table --limit 75 --service worker` | File validation, CSV processing, filtering, numeric bounds |
| `json-format.py` | `--input examples/data/service.json --sort` | Files or stdin, booleans, pretty/compact choice, JSON stdout |
| `media-info.sh` | `examples/data/tone.wav` | FFprobe metadata inspection |
| `transcode.sh` | `examples/data/tone.wav /tmp/clyops-demo.m4a` | FFmpeg command preview, quality range, encoder preset |
| `upload.sh` | `examples/data/service.json --url https://example.com/upload` | curl HTTP PUT preview, secret bearer token, bounded timeout |

Prefix these tool names with `./examples/scripts/`, or add that directory to PATH.
The media tools need FFmpeg to execute; upload needs curl. Their generated help,
schema and completion work without those optional dependencies. Transcode and
upload preview by default; `--execute` performs the operation. Transcode refuses
to overwrite its output, and upload previews redact bearer tokens. The bundled
tone/CSV/JSON keep the walkthrough self-contained.

## The same scripts in the web runner

From the cloned repository:

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/api/dist/cli.js --root ./examples/scripts --port 8788
```

Open `http://127.0.0.1:8788/ui/`. Select a Python tool to run immediately. Choices
become dropdowns, numeric ranges become bounded controls, and JSON-format exposes
stdin and file upload. Upload's token uses a secret field; network/destructive
effects prompt confirmation. Enable the wrapper's execute override to perform
its operation. Scripts execute on the API host and use its installed tools.

The scripts also work with the [MCP server](node-tools.md#mcp),
[dispatcher and desktop runner](applications.md).
See the [example directory README](../examples/README.md) for the full commands.

## Browser playground

The [homepage playground](/#playground) executes the real Python library and
`plan.py`, `report.py`, and `json-format.py` sources using
[Pyodide](https://pyodide.org/en/stable/usage/webworker.html). It loads Python only
when you press Start; the first load needs a network connection to the pinned
Pyodide CDN. Execution and the sample filesystem stay in a Web Worker in your tab.

Try `plan.py --help`, `plan.py --replicas 99`, `report.py --format table`, or
`plan.py --help-json-schema`. `cat examples/scripts/plan.py` shows the source.
Tab completes commands/options/choices from the actual completion protocol;
Up/Down recall commands. The stdin panel supplies input for `json-format.py`.
Reset terminates the worker and restores the workspace when you start again.
`ls` labels the Bash files as source examples to run locally; `cat` lets you
read them here, and attempting to run one explains which runtime is needed.

This is a Python command playground, with `help`, `ls`, `cat`, `pwd` and `clear`.
It has no host shell, Bash, FFmpeg, curl, pipes or live agent connection. Run the
local scripts or API for those workflows. The animated hero remains an
[illustrative walkthrough](demo.md); the playground performs real executions.
