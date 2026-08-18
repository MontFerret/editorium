# VS Code distribution

Editorium produces one Ferret VSIX for each supported VS Code target. The
packages all use the extension version in `vscode/package.json` and the daemon
version pinned in the repository-root `ferretd.json`.

| VS Code target | Official ferretd artifact | Native CI runner |
| --- | --- | --- |
| `darwin-arm64` | `ferretd_darwin_arm64.tar.gz` | `macos-14` |
| `darwin-x64` | `ferretd_darwin_x86_64.tar.gz` | `macos-15-intel` |
| `linux-x64` | `ferretd_linux_x86_64.tar.gz` | `ubuntu-24.04` |
| `linux-arm64` | `ferretd_linux_arm64.tar.gz` | `ubuntu-24.04-arm` |
| `win32-x64` | `ferretd_windows_x86_64.zip` | `windows-2025` |
| `win32-arm64` | `ferretd_windows_arm64.zip` | `windows-11-arm` |

The target table in `scripts/distribution.mjs` is authoritative; the CI matrix
is generated from it rather than duplicated in workflow YAML.

## Build a distribution

Run the package command from the repository root with a target:

```sh
npm ci
npm run vscode:package -- --target linux-x64
```

The workflow downloads `ferretd_checksums.txt` and the matching archive only
from the pinned official GitHub release. It verifies SHA-256 before extracting
or executing anything, stages one `bin/ferretd` or `bin/ferretd.exe`, calls
`vsce package --target`, and validates the resulting VSIX. A checksum mismatch,
missing executable, malformed archive, wrong package target, unexpected file,
lost executable bit, byte mismatch, or incorrect native version fails closed.

Unix targets may be cross-packaged on another Unix host. Windows hosts reject
Unix targets because `vsce` cannot preserve their POSIX executable mode.
Official release packages should come from the native CI jobs so every daemon
is executed both before and after VSIX packaging.

The resulting files follow the `vsce` platform convention:

```text
fql-darwin-arm64-<extension-version>.vsix
fql-darwin-x64-<extension-version>.vsix
fql-linux-x64-<extension-version>.vsix
fql-linux-arm64-<extension-version>.vsix
fql-win32-x64-<extension-version>.vsix
fql-win32-arm64-<extension-version>.vsix
```

## Update the daemon pin

1. Confirm the official `ferretd` release contains all six artifacts plus
   `ferretd_checksums.txt`, and that `ferretd --version` reports the intended
   version.
2. Change only the `ferretd` value in the root `ferretd.json`.
3. Run the offline tests, then package the native target locally.
4. Let the CI matrix acquire, execute, package, and validate every target.

Do not commit `.dist/`, `vscode/bin/`, or generated VSIX files. Do not replace
the official artifacts with locally compiled binaries.

## Publication handoff

Marketplace publication is intentionally outside this milestone. A future
release workflow should take the six validated CI artifacts and publish them
under the same extension version as platform-specific packages. It must not
create a universal fallback VSIX or rebuild daemon binaries inside Editorium.
