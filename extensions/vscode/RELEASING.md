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
GitHub Release. A rerun is a no-op when published metadata and assets already
match; an incomplete draft is replaced.

The GitHub Release is the canonical distribution archive. For an exact numeric
`major.minor.patch` version, the workflow next publishes the same validated
VSIX bytes to Visual Studio Marketplace. The Marketplace job does not rebuild
or repackage the extension. A Marketplace failure leaves the GitHub Release
intact and fails the workflow visibly so publication can be resumed.

SemVer prerelease versions such as `0.2.0-alpha.1`, `0.2.0-beta.1`, and
`0.2.0-rc.1` continue to create GitHub prereleases but intentionally skip
Marketplace publication. Versions with build metadata also skip because the
Marketplace extension version must be exactly `major.minor.patch`. The
Marketplace pre-release channel and its separate numeric version progression
are not implemented; the workflow never passes `--pre-release`.

## Configure temporary Marketplace PAT publishing

The source-controlled Marketplace identity is:

```text
Publisher: ferretlang
Extension: ferretlang.ferret
```

Before pushing the first stable release tag:

1. In GitHub, create an environment named `vscode-marketplace`. Leave it
   without required reviewers by default. Protection rules can be added later
   without changing the workflow.
2. Add an environment secret named `VSCE_PAT`. Its Azure DevOps PAT must use
   `All accessible organizations` and the `Marketplace (Manage)` scope. The
   Microsoft account that created it must have publishing access to
   `ferretlang`.
3. Give the PAT the shortest practical expiration. Treat it as a password:
   never pass it as a command argument, print it, or store it in the repository.
   Replace the environment secret before it expires, verify the replacement,
   and revoke the old PAT.

This PAT flow is temporary. Microsoft retires global Azure DevOps PATs on
December 1, 2026; the workflow must return to trusted publishing before then.
See the [official Marketplace publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).

The Marketplace job has only `contents: read`. It exposes `VSCE_PAT` only to
the publication step; the pinned `vsce` executable reads the token from that
environment variable. The job uses Node.js 22, installs the exact
`@vscode/vsce` version from `extensions/vscode/package-lock.json`, downloads
the six existing workflow artifacts, and verifies the complete canonical
target set before the first remote operation. It then runs, in deterministic
filename order:

```sh
LC_ALL=C node extensions/vscode/node_modules/@vscode/vsce/vsce publish \
  --skip-duplicate \
  --packagePath release-assets/*.vsix
```

The token is not passed with `--pat`, so it is absent from the command line and
logs. Each VSIX retains the target metadata created by the
`vsce package --target` build step; the publishing command does not pass a
second target list.

## Recover a Marketplace publication

Marketplace uploads are sequential remote operations and cannot be fully
transactional. The workflow minimizes partial releases by verifying that all
six non-empty expected VSIX files are present before invoking `vsce`. An
unexpected upload error stops the command immediately and fails the job.

Rerun the failed workflow for the same tag. The matching GitHub Release remains
a no-op. `--skip-duplicate` skips a publisher/name/version/target combination
already present in Marketplace and continues with missing targets; it does not
skip local artifact, manifest, publisher, or version validation, and it does
not compare already-published remote bytes.

Authentication failures are distinct from package failures:

- `Missing environment secret VSCE_PAT` means the secret is missing, misnamed,
  or unavailable to the `vscode-marketplace` job.
- `Unauthorized(401)` or an expired-token error means the PAT is invalid or has
  expired; replace the secret and revoke the unusable token.
- `Forbidden(403)` usually means the PAT was not created for
  `All accessible organizations`, lacks `Marketplace (Manage)`, or belongs to
  an account without publishing access to `ferretlang`.
- VSIX manifest, publisher, target, version, or package-content errors are
  package validation failures and must be fixed in source; they are not PAT
  configuration failures.

Validate the workflow and package structure locally, configure the environment
secret, and use the first intended stable release as the end-to-end test. Do
not publish a disposable production extension version merely to test the PAT.

## Restore Marketplace trusted publishing

When Visual Studio Marketplace exposes GitHub trusted-publisher policies,
configure the policy with these exact values:

```text
GitHub organization: MontFerret
Repository:          editorium
Workflow:            .github/workflows/release-vscode.yml
Publisher:           ferretlang
```

If the Marketplace UI offers an environment restriction, set it to
`vscode-marketplace`; otherwise retain the narrow workflow-file restriction.
Then remove the `VSCE_PAT` step environment and missing-secret check, restore
`id-token: write`, and add `--oidc` to the same publication command. After a
successful OIDC publication, revoke the PAT and delete the `VSCE_PAT` GitHub
environment secret. Do not keep PAT fallback authentication alongside OIDC.
