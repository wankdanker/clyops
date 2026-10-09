# clyops runner

A desktop app (Tauri + React) for running clyops tools without remembering their flags. Point it at
a directory of tools and it builds a form for each one from its `--help-json-schema` output, runs
it, and streams the output, so any program built with any clyops package gets a UI for free.

- **Discovery:** every executable in the tools directory is listed. Selecting one runs
  `tool --help-json-schema`, and programs that answer with a clyops schema
  ([spec/schema.json](../../spec/schema.json)) get a form.
- **Forms:** grouped options, typed inputs (numbers, choices, flags, paths), repeatable options and
  variadic arguments, required fields marked.
- **Running:** run several instances at once and watch stdout/stderr live. Copy the equivalent
  command line, or paste a command line to fill the form.
- **Templates:** save and reload form values per tool.

## Install

Download the installer for your platform from the
[latest release](https://github.com/wankdanker/clyops/releases/latest): `.deb`, `.rpm` or
`.AppImage` on Linux, `.dmg` on macOS (universal), `.msi` or setup `.exe` on Windows. The builds
are not signed with a paid certificate yet: on macOS right-click the app and choose **Open** the
first time, and on Windows choose **More info → Run anyway**.

## Development

Requirements: Node 20+, Rust stable, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/)
(on Debian/Ubuntu: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`).

```sh
npm install
npm run tauri dev      # dev server + app window
npm run tauri build    # installers in src-tauri/target/release/bundle/
```

Tests (`src-tauri`): `cargo test` checks that the runner reads the conformance golden schema and
loads a real tool. Build the C demo it uses first with `make -C ../../packages/c`.

## Configuration

| Setting | Priority |
| --- | --- |
| Tools directory | `CLYOPS_RUNNER_DIR` → directory saved in Settings |
| Templates directory | `CLYOPS_RUNNER_TEMPLATES_DIR` → directory saved in Settings → app data dir |

Tools run with their own directory as the working directory.
