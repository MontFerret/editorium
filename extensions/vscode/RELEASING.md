# VS Code distribution

Editorium produces one Ferret VSIX for each supported VS Code target. The
packages all use the extension version in `extensions/vscode/package.json` and
the daemon/protocol version pinned in the repository-root `ferretd.json`.
The canonical VS Code release tag is `vscode/v<version>`; this namespace keeps
the extension independently versioned from future Editorium targets.

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

The resulting files use deterministic release asset names:

```text
ferret-vscode-<extension-version>-darwin-arm64.vsix
ferret-vscode-<extension-version>-darwin-x64.vsix
ferret-vscode-<extension-version>-linux-x64.vsix
ferret-vscode-<extension-version>-linux-arm64.vsix
ferret-vscode-<extension-version>-win32-x64.vsix
ferret-vscode-<extension-version>-win32-arm64.vsix
```

## Update the daemon pin

1. Confirm the official `ferretd` release contains all six artifacts plus
   `ferretd_checksums.txt`, and that `ferretd --version` reports the intended
   version.
2. Change only the `ferretd` value in the root `ferretd.json`.
3. Run `npm run proto:sync` and
   `npm run proto:generate --workspace fql`, then review the generated client
   changes.
4. Run the tests, then package the native target locally.
5. Let the CI matrix acquire, execute, package, and validate every target.

Do not commit `.dist/`, `shared/proto/ferretd/`,
`extensions/vscode/bin/`, or generated VSIX files. Do not replace the official
artifacts with locally compiled binaries.

## Publish a GitHub Release

1. Update `extensions/vscode/package.json` to the intended SemVer version.
2. Commit and merge the version change.
3. Create the exactly matching namespaced tag, for example:

   ```sh
   git tag vscode/v0.1.0
   ```

4. Push the tag:

   ```sh
   git push origin vscode/v0.1.0
   ```

The dedicated release workflow validates the `vscode/v<version>` tag and
requires its version to match `extensions/vscode/package.json` exactly before
running any packaging job. It then runs the same build, test, native daemon,
VSIX validation, and installed-package checks as ordinary CI for every target
in the authoritative distribution table above.

Only after all six target jobs succeed does the workflow create the GitHub
Release and attach the complete VSIX set. SemVer prerelease versions such as
`vscode/v0.2.0-beta.1` create GitHub prereleases; stable versions create normal
releases. Rerunning a completed release is a no-op when its metadata and asset
set already match, while an incomplete draft from an interrupted attempt is
replaced.

Marketplace publication is not part of this workflow. It uses no Marketplace
credentials, does not run `vsce publish`, and does not modify or infer the
package version.
