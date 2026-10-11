---
title: Bash, Zsh and Fish completion
---
# Bash, Zsh and Fish completion

Every clyops tool generates its own shell completion. Options, enum values, file
and directory paths, hosts, nested commands and inherited options come from the
tool's current declarations. No hand-maintained completion file is needed when
you change its options.

For a tool installed on PATH, replace `plan.py` below with its executable name.
To use the [cloned examples](examples.md), first run the PATH setup from your
shell while you are in the repository root. These commands enable the current
shell session. Put PATH and initialization lines in your startup file to retain
them, using the absolute checkout path rather than `$PWD` there.

## Bash

Use Bash 4.3+; on macOS put a current Bash on PATH and start it first.

```bash
export PATH="$PWD/examples/scripts:$PATH"
eval "$(plan.py --completion bash)"
```

Type `plan.py --env ` and press Tab to complete `staging` or `production`.

For future sessions, add to `~/.bashrc` after adjusting the checkout path:

```bash
export PATH="/absolute/path/to/clyops/examples/scripts:$PATH"
eval "$(plan.py --completion bash)"
```

Your login shell may need to source `~/.bashrc` from `~/.bash_profile`.
The generated function queries the executable when you complete; keep the tool
on PATH and use the registered executable name. To enable the other samples,
run the corresponding command, e.g. `eval "$(transcode.sh --completion bash)"`.

## Zsh

Initialize Zsh's completion system before registering the tool:

```zsh
export PATH="$PWD/examples/scripts:$PATH"
autoload -Uz compinit
compinit
eval "$(plan.py --completion zsh)"
```

Put the same lines in `~/.zshrc`, replacing `$PWD` with the absolute checkout
path. If your shell framework already runs `compinit`, add only the PATH and
`eval` lines after that initialization.

## Fish

In Fish, from the checkout root:

```fish
fish_add_path "$PWD/examples/scripts"
mkdir -p ~/.config/fish/completions
plan.py --completion fish > ~/.config/fish/completions/plan.py.fish
```

Fish automatically loads that file for `plan.py`. For just the current session:

```fish
plan.py --completion fish | source
```

The saved script asks the tool for its current declarations at completion time.
Repeat the install command for each tool, using its executable name as the filename.

## A directory of tools

The [dispatcher](applications.md#dispatcher) also generates completion:

```sh
clyops-dispatch --root ./examples/scripts --help
clyops-dispatch --root ./examples/scripts --name ops --completion bash
```

For convenient completion, use a wrapper that always supplies the root:

```bash
#!/usr/bin/env bash
exec clyops-dispatch --root /absolute/path/to/clyops/examples/scripts --name ops "$@"
```

Save this as an executable named `ops` on PATH. Enable it with
`eval "$(ops --completion bash)"`, `eval "$(ops --completion zsh)"` after `compinit`,
or `ops --completion fish > ~/.config/fish/completions/ops.fish`.
The dispatcher completes directory groups and tool names, then the selected
tool's own options. Inspect `ops --help` for the command names it discovered.

## Inspect and troubleshoot

`plan.py --completion bash` prints shell source; `plan.py --bash-completion`
prints the tab-separated records the generated completion script consumes.
The internal protocol's historical name is used by all three shells.
Try `command -v plan.py` and `plan.py --help` if completion does not appear.
When using an interpreter directly, completion belongs to the tool's executable
name rather than a global `python` command; prefer an executable shebang script.
See the [shared behavior guide](guide.md#help-schema-and-shell-completion).
