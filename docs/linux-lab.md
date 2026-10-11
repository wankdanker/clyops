---
title: Linux lab
layout: linux-lab.njk
---
## Try the whole workflow

The guest starts in `/workspace`, with the example scripts on PATH and Bash
completion already enabled. This is an ordinary Linux shell: pipes, redirection,
history, environment variables, `cat`, `ls` and the programs' real help work here.

```bash
ls examples/scripts
media-info.sh examples/data/tone.wav
transcode.sh examples/data/tone.wav /tmp/tone.m4a --execute
upload.sh /tmp/tone.m4a --url http://127.0.0.1:9000/upload --execute
plan.py --env production --replicas 3 | json-format.py --sort
```

Transcode produces an actual AAC audio file with FFmpeg. The upload sends a real
HTTP PUT through curl to a Python server inside this Linux guest. Its response
contains the received byte count, SHA-256 and saved path. Use the download button
to save the audio output to your computer. Scripts, validation and completion
come directly from this checkout's Bash/Python library and examples.

Files you add appear under `/workspace/inbox/`. For example, inspect one with
`media-info.sh '/workspace/inbox/your file.wav'`. You can freely edit the guest's
files and scripts; everything lives in memory for this session. Stop & reset
unloads the emulator, and Start restores a fresh guest.

## What runs where

[v86](https://github.com/copy/v86) emulates a 32-bit PC and executes Alpine Linux
and normal Linux binaries in a Web Worker. The website serves static assets;
it does not execute your commands on a server. No network relay is configured,
so the guest's upload server is reachable inside the guest and public internet
destinations are unavailable. The lab needs a connection to load its static
filesystem assets. Large files and long encodes are better run locally.

For a smaller download, the [Python playground](/#playground) runs three of the
same examples directly in Pyodide. For your real filesystem and network,
[clone and run the scripts](examples.md) or use the [web runner](web-runner.md).

## Guest software and sources

The lab uses Alpine Linux packages with their individual upstream licenses.
[Package versions and licenses](/assets/linux-lab/packages.json) and the
[v86 license](/assets/linux-lab/v86-LICENSE.txt) ship with the assets.
The [guest build recipe](../tools/linux-lab) and [asset builder](../tools/build-linux-lab.py)
describe the image. The package index records each origin's Alpine source commit
and upstream project; corresponding Alpine build recipes and source patches are
in [Alpine aports](https://gitlab.alpinelinux.org/alpine/aports).
