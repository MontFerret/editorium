# VS Code distribution

Editorium produces one Ferret VSIX for each supported VS Code target. Every
package uses the extension version in `extensions/vscode/package.json` and the
daemon/protocol version pinned in the root `ferretd.json`. The canonical release
tag is `vscode/v<version>`, keeping this integration independently versioned.

| VS Code target | Official ferretd artifact | Native CI runner |
| --- | --- | --- |
| `darwin-arm64` | `ferretd_darwin_arm64.tar.gz` | `macos-26` |
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

From a clean local `main` tracking and exactly matching `origin/main`, run:

```sh
make release vscode patch
make release vscode minor
make release vscode major
make release vscode 2.0.0
make release vscode 0.3.0-rc.1
make release vscode rc
```

Relative increments use the highest SemVer release tag on `origin` in the
`vscode/v<version>` namespace, independently of JetBrains versions. Without a
previous release, the package manifest is the baseline. The manifest may equal
the baseline or already contain the exact calculated target; a conflicting
advanced version fails with guidance to use an explicit version. A manifest
behind the latest remote release fails for both relative and explicit requests:
correct it in a separate commit first. Explicit versions must not downgrade the
manifest and must exceed the latest release in SemVer precedence. Existing local
or remote tags are never replaced; build metadata does not increase precedence.

Prerelease identifiers increment an existing matching series: `0.3.0-rc.1` plus
`rc` becomes `0.3.0-rc.2`. Start a different series explicitly. `patch` promotes a
prerelease to its stable core; `minor` does so when patch is zero; `major` does so
when both minor and patch are zero. Otherwise the requested numeric component
increments and lower components reset.

The command prints its plan, synchronizes `package.json.version` and both root
version fields in `package-lock.json`, and preserves dependencies and unrelated
metadata. `package.json` is authoritative; stale lockfile root versions produce a
warning and are repaired. Qualification runs Go tests, vet and formatting checks,
`npm ci`, preparation, build, lint, complete tests, host (or `TARGET`) packaging,
and package verification. The shared `ferretd.json` pin is unchanged.

After checking the exact manifest edits, checkout, and remote refs again, the
command commits only changed release manifests as
`chore(release): vscode v<version>`, creates an annotated `vscode/v<version>` tag,
and pushes `main` and that tag atomically to `origin`. If all version fields
already match, it tags the existing commit without a redundant commit. The
remote must support atomic push and use one identical fetch/push destination.
Git identity must be configured. Branch protection or rejected pushes fail the
transaction; there is no force-push or separate-push fallback.

### Check without publishing

```sh
RELEASE_CHECK_ONLY=1 make release vscode patch
```

This performs the same qualification, including `npm ci` and packaging with the
proposed version, then restores original manifests without staging a release,
creating a release commit/tag, or pushing. Fetch refs and ignored dependency and
build caches may remain. It has the same clean, synchronized `main` requirement.

### Recover a local release transaction

Validation, commit, tag, or confirmed atomic-push failure restores only the
transaction's own manifest edits, staging, commit, and tag. Unexpected edits and
concurrent commits/refs are preserved for inspection. Ordinary cancellation also
attempts bounded cleanup; a forcibly killed process cannot run cleanup.

After a push error, the tool checks remote `main`, the annotated tag object, and
its peeled commit. If all match the intended release, it reports success. If
non-publication is confirmed, it rolls back locally. If remote state cannot be
confirmed or conflicts, it retains local recovery state and reports the commit
and tag identity. Inspect them before retrying:

```sh
git status
git reflog main
git ls-remote origin refs/heads/main 'refs/tags/vscode/v<version>' 'refs/tags/vscode/v<version>^{}'
```

Do not recreate or move a published tag. When inspection confirms the original
transaction can safely be resumed, push its original commit and annotated tag
object together with `git push --atomic --no-follow-tags`; do not send independent
pushes or force updates. Resolve unexpected local edits separately before
starting another automated release.

The tag-triggered workflow validates the tag/manifest match and builds all six
native packages. Only after the complete asset set succeeds does it create the
GitHub Release. The GitHub Release job reuses an existing published release
with matching metadata and asset names. A tag-triggered run replaces an
incomplete draft.

The GitHub Release is the canonical distribution archive. For an exact numeric
`major.minor.patch` version, the workflow next publishes the same validated
VSIX bytes to Visual Studio Marketplace. The Marketplace job checks each
qualified artifact against the published GitHub Release's SHA-256 digest before
uploading. A Marketplace failure leaves the GitHub Release intact and fails
the workflow so the maintainer can recover it.

SemVer prerelease versions such as `0.2.0-alpha.1`, `0.2.0-beta.1`, and
`0.2.0-rc.1` continue to create GitHub prereleases but intentionally skip
Marketplace publication. Versions with build metadata also skip because the
Marketplace extension version must be exactly `major.minor.patch`. The
Marketplace pre-release channel and its separate numeric version progression
are not implemented; the workflow never passes `--pre-release`.

## Configure Marketplace Trusted Publishing

In GitHub, keep the `vscode-marketplace` environment. Set its deployment
branches and tags to **Selected branches and tags**, with a branch rule for
`main` and a tag rule for `vscode/v*`. The branch rule admits manual recovery.
The tag rule admits the normal release workflow. See the
[GitHub deployment rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags).

In Visual Studio Marketplace, open the publisher for `ferretlang.ferret-lang`,
select **Trusted Publishing**, then create a policy with these values.

| Setting | Value |
| --- | --- |
| Publisher | `ferretlang` |
| Repository owner | `MontFerret` |
| Repository | `editorium` |
| Workflow | `release-vscode.yml` |
| Environment | `vscode-marketplace` |

See the [Marketplace Trusted Publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing).

Only the Marketplace job gets `id-token: write` for the OIDC token. Its other
permission is `contents: read` for the GitHub Release and tag. The job uses
Node.js 22 and installs `@vscode/vsce` version `4.1.1` through `npm ci`. It
publishes the prebuilt VSIX files in deterministic filename order.

```sh
LC_ALL=C node extensions/vscode/node_modules/@vscode/vsce/vsce publish \
  --oidc \
  --skip-duplicate \
  --packagePath release-assets/*.vsix
```

After the first successful OIDC publication, delete `VSCE_PAT` from the GitHub
environment and revoke the obsolete PAT in Azure DevOps.

## Recover a Marketplace publication

Once the OIDC workflow is merged into `main` and the Trusted Publishing policy
is configured, go to **Actions → Release VS Code extension → Run workflow**.
Select branch `main` and enter the full existing stable tag in `release_tag`.
To recover the failed Marketplace upload for `vscode/v0.2.0`, enter that tag or
run the equivalent command.

```sh
gh workflow run release-vscode.yml --repo MontFerret/editorium --ref main \
  -f release_tag=vscode/v0.2.0
```

Recovery runs the workflow and publishing tool from `main`. It reads the
version at the requested tag and requires its already-published GitHub Release
with all six expected VSIX files. It downloads those assets, verifies their
sizes, checksums, identities, and targets, then passes the original files to
`vsce`. GitHub releases, assets, and tags are read-only during recovery.

Uploads run sequentially. If some variants already made it to Marketplace,
`--skip-duplicate` skips each existing publisher, extension, version, and
target combination and continues with the missing variants. It checks presence
only. After an upload failure, dispatch recovery again with the same tag. The
original `vscode/v0.2.0` workflow revision predates OIDC.

### Troubleshoot publishing

- If GitHub rejects the deployment, check that the dispatch uses `main` and
  the selected deployment rules admit that branch and the release tag pattern.
- If `vsce` reports a missing OIDC request URL or token, check that the
  Marketplace job has `id-token: write` and uses the pinned CLI from the run's
  checkout.
- If the Marketplace token exchange returns 401 or 403, verify all five
  policy fields against the run and publisher. OIDC exchange failure stops
  publication. Fix the policy and dispatch recovery with the same tag.
- If the workflow reports a missing release, incorrect digest, or invalid
  VSIX metadata, inspect the existing GitHub Release and the tag before
  retrying. Every package must pass validation before any upload begins.
