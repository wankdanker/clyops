
### Downloads

| | |
| --- | --- |
| **clyops runner** | Linux: `.deb`, `.rpm` or `.AppImage` (x64 `amd64`/`x86_64`, arm64 `arm64`/`aarch64`) · macOS: `_universal.dmg` · Windows: `_x64-setup.exe` or `_x64_en-US.msi` |
| **C** | `libclyops-<version>-<platform>.tar.gz` (static library + header) or `-src.tar.gz` |
| **Bash** | `clyops.sh` |
| **JavaScript / TypeScript** | `clyops-<version>.tgz` (`npm install ./clyops-<version>.tgz`) |
| **Python** | `clyops-<version>-py3-none-any.whl` or the sdist |
| **Rust** | `clyops-<version>.crate` |

`SHA256SUMS` lists a checksum for every file.

The runner installers are not signed with a paid certificate yet. On macOS, right-click the app
and choose **Open** the first time (or run `xattr -dr com.apple.quarantine "/Applications/clyops-runner.app"`).
On Windows, choose **More info → Run anyway** in the SmartScreen prompt.
