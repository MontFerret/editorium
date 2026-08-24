# VS Code distribution

Editorium produces one Ferret VSIX for each supported VS Code target. Every
package uses the extension version in `extensions/vscode/package.json` and the
daemon/protocol version pinned in the root `ferretd.json`. The canonical release
tag is `vscode/v<version>`, keeping this integration independently versioned.

| VS Code target | Official ferretd artifact | Native CI runner |
| --- | --- | --- |
| `darwin-arm64` | `ferretd_darwin_arm64.tar.gz` | `macos-14` |
| `darwin-x64` | `ferretd_darwin_x86_64.tar.gz` | `macos-15-intel` |
| `linux-x64` | `ferretd_linux_x86_64.tar.gz` | `ubuntu-24.04` |
| `linux-arm64` | `ferretd_linux_arm64.tar.gz` | `ubuntu-24.04-arm` |
| `win32-x64` | `ferretd_windows_x86_64.zip` | `windows-2025` |
| `win32-arm64` | `ferretd_windows_arm64.zip` | `windows-11-arm` |

The explicit target catalog in `tools/editorium` is authoritative. It keeps
VS Code identifiers, Go host normalization, official artifact/archive names,
executables and modes, CI runners, and deterministic filenames together. CI
generates its matrix from that catalog instead of duplicating it in workflow
YAML.

## Build a distribution

Install the native VS Code tools once, then package from the repository root:

```sh
npm --prefix extensions/vscode ci
make package vscode TARGET=linux-x64
```

Omit `TARGET` to package the host. The adapter downloads
`ferretd_checksums.txt` and the matching archive only from the pinned official
GitHub release. It verifies SHA-256 before safe, bounded root-file extraction;
stages one `bin/ferretd` or `bin/ferretd.exe`; invokes `vsce package --target`;
and validates the resulting VSIX. A corrupt cache entry is evicted. A checksum
mismatch, malformed archive, wrong target or manifest, unexpected file, lost
executable bit, byte mismatch, or incorrect native version fails closed.

Unix targets may be structurally cross-packaged on another Unix host. Windows
hosts reject Unix targets because `vsce` cannot preserve their POSIX executable
mode. Official releases use native CI jobs so every daemon is executed before
and after VSIX packaging.

The release assets are named deterministically:

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
3. Run `make proto-sync FORCE=1` and `make proto-generate vscode`, then review
   the generated client changes.
4. Run `make lint`, `make test`, and `make package vscode`.
5. Let CI acquire, execute, package, and validate every native target.

Do not commit `.dist/`, `shared/proto/ferretd/`,
`extensions/vscode/bin/`, or `extensions/vscode/dist/`. Do not replace the
official artifacts with locally compiled binaries.

## Publish a GitHub Release

1. Update `extensions/vscode/package.json` to the intended canonical SemVer.
2. Commit and merge that version change to `main`.
3. On a clean local `main` that tracks and exactly matches `origin/main`, run:

   ```sh
   make release vscode 0.1.0
   ```

The release command fetches remote `main` and `vscode/*` tags into isolated
refs, validates the branch/upstream/cleanliness and tracked manifest, rejects
an existing local or remote tag, and requires the explicit version to equal the
manifest. It then runs the same Go checks, prepare, build, lint, complete test,
host packaging, and package verification adapters used by Make. After a final
cleanliness, HEAD, and tag-availability check, it creates an annotated
`vscode/v<version>` tag at the unchanged HEAD and pushes that tag to `origin`.

The command never edits the manifest, creates a release commit, infers a version,
or publishes locally. If the push fails, it removes the local tag unless the
remote is confirmed to contain that exact tag at the intended commit.

The tag-triggered workflow validates the tag/manifest match and builds all six
native packages. Only after the complete asset set succeeds does it create the
GitHub Release. SemVer prereleases create GitHub prereleases. A rerun is a no-op
when published metadata and assets already match; an incomplete draft is
replaced.

Marketplace publication is not part of this workflow. It uses no Marketplace
credentials, never invokes `vsce publish`, and does not modify or infer the
package version.
