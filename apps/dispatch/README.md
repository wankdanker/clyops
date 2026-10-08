# clyops-dispatch

Turn a directory of tools into one command with nested subcommands, help and shell completion.
Point it at a folder of scripts and programs, and each executable becomes a subcommand named
after its file, with folders becoming groups of subcommands at any depth.

```
scripts/
  whspr                  ← the dispatcher
  check.sh               → whspr check
  media/
    .clyops              (description: Media conversion tools)
    to-pcm.sh            → whspr media to-pcm
    fp/
      index.py           → whspr media fp index
```

## Install

Download `clyops-dispatch` for Linux, macOS or Windows from the
[latest release](https://github.com/wankdanker/clyops/releases/latest) and put it on your `PATH`,
or build it with `cargo install clyops-dispatch`.

## Define a dispatcher

A dispatcher is a small text file whose shebang runs `clyops-dispatch`:

```
#!/usr/bin/env clyops-dispatch
description: whisper.c toolchain
ignore: lib, docx
```

Make it executable and symlink it into your `PATH` (`ln -s "$PWD/scripts/whspr" ~/.local/bin/`).
The tools are found next to the real file, so the symlink can live anywhere.

| Key | Meaning |
| --- | --- |
| `description` | Shown at the top of the help. |
| `dir` | Tools directory, relative to the definition (default: the definition's own directory). |
| `ignore` | Comma-separated file or command names to leave out. |

A group directory can hold a `.clyops` file with its own `description` and `ignore`.

## Or just an alias

No definition file needed: point `--root` at the tools directory and name the command. A
`.clyops` file in that directory gives it a description and an ignore list.

```sh
alias whspr='clyops-dispatch --root ~/whisper.c/scripts --name whspr'          # bash, fish
whspr() { clyops-dispatch --root ~/whisper.c/scripts --name whspr "$@"; }       # zsh (also bash, fish)
eval "$(whspr --completion bash)"
```

zsh expands aliases before completing them, so use the function form there. The completion script
printed in this mode calls `clyops-dispatch --root … --name …` itself, so completion works for the
alias or function name.

## Use it

```sh
whspr                      # commands and groups, with descriptions
whspr media                # the media group
whspr media to-pcm in.wav  # runs scripts/media/to-pcm.sh in.wav
whspr media to-pcm --help  # the command's own help
eval "$(whspr --completion bash)"   # or zsh / fish
```

Completion covers group and command names at every level, then the chosen command's own options
and values.

Descriptions come from each command's `--help-json-schema` and are cached until the file changes.
To describe or complete a command, the dispatcher has to run it, so it only runs programs that use
a clyops library: files that load `clyops.sh` or import the Python or JavaScript package, compiled
C and Rust clyops programs, and other dispatchers. A wrapper script can opt in with a
`# clyops-tool` comment. Any other executable is still listed and runnable, just without a
description, and completes file names.

On Windows there are no shebangs: run `clyops-dispatch path\to\definition <command> ...`. Commands
are files with an extension listed in `PATHEXT`.

The full behavior is specified in [spec/SPEC.md](../../spec/SPEC.md) section 12.
