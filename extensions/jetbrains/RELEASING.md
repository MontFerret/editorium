# Releasing Ferret for JetBrains IDEs

## Qualification and tagging

From a clean local `main` tracking and exactly matching `origin/main`, run:

```sh
make release jetbrains patch
make release jetbrains minor
make release jetbrains major
make release jetbrains 0.2.0
make release jetbrains 0.3.0-rc.1
make release jetbrains rc
```

`pluginVersion` in `gradle.properties` remains the version source. The command
calculates relative increments from the highest SemVer remote
`jetbrains/v<version>` release tag, independently of VS Code. With no prior
release, it uses the manifest. An already-prepared manifest is accepted only if
it equals the calculated target; another advanced version requires an explicit
request. A manifest behind the latest remote release is rejected even for an
explicit request and must be corrected in a separate commit. Explicit versions
cannot downgrade the manifest and must exceed the latest release in SemVer
precedence; build metadata does not increase precedence. Existing tags are
never replaced.

A prerelease identifier increments only a matching series: `0.3.0-rc.1` plus
`rc` becomes `0.3.0-rc.2`. Start a series with an explicit version. `patch`
promotes a prerelease to its stable core, `minor` promotes when patch is zero,
and `major` promotes when minor and patch are both zero. Otherwise the selected
component increments and lower components reset.

The command prints the release plan, updates only `pluginVersion`, and runs Go
checks, preparation, build, lint, strict tests, packaging, and package verification.
Before packaging, it removes recognized generated plugin ZIPs from the distribution
output so older versions cannot violate the exact-one-archive check; unexpected
ZIPs fail preparation and are preserved.
The strict test uses `FERRET_TEST_PASSIVE_HOST_LOSS=1`: it kills the owned Wire
application at a confirmed breakpoint and requires a stderr diagnostic, exit
code 1, adapter shutdown, and released admission without Continue. Record these
results and the interactive GoLand smoke in the
[validation record](docs/debugger-validation.md).

After rechecking the expected manifest edits, repository, and remote refs, the
command creates `chore(release): jetbrains v<version>` when a manifest change is
needed, annotates `jetbrains/v<version>` at that commit, and atomically pushes
`main` plus the tag. Already-matching manifests produce no redundant commit.
Git identity must be configured; `origin` must have one identical fetch/push
URL and support atomic pushes. Branch protection and rejected pushes fail
without force-pushing or falling back to independent pushes. `ferretd.json`
continues independently pinning the daemon bundled in both editors.

For full qualification without a release:

```sh
RELEASE_CHECK_ONLY=1 make release jetbrains minor
```

The same checks run using the proposed version, then original manifest bytes
are restored without staging, creating a release commit/tag, or pushing. Fetch
refs and ignored build caches may remain. The local unsigned package is not a
signing input; CI rebuilds from the final tagged commit and embeds that commit.

Tag CI reads the annotated tag object and its peeled commit from `origin`.
The Linux, macOS and Windows test jobs check out that commit. The package job
checks all four configured IDE builds and transfers the qualified ZIP by
Actions artifact ID and SHA-256. Signing, GitHub publication, and Marketplace
upload each recheck the remote annotation and commit before proceeding.

After qualification, publication preflight checks for drafts and existing
releases. Only an absent release proceeds to signing. The read-only signing
job verifies the packaged descriptor, commit, complete runtime library set
and external JAR hashes against the tagged Gradle configuration. It compares
all six daemons to the verified release binaries and runs the native smoke.
The publication job checks the signed artifact ID's ZIP and sidecar against
the signing job's digest and rechecks release state. GitHub stores exactly
these two assets, with a 400,000,000-byte ceiling on the ZIP.

```text
ferret-jetbrains-<version>-signed.zip
ferret-jetbrains-<version>-signed.zip.sha256
```

Only exact stable `major.minor.patch` versions can go to the default Marketplace
channel. Prereleases are GitHub prereleases. Versions with SemVer build metadata
are also GitHub-only. The release job always downloads and verifies the original
GitHub assets before a Marketplace submission.

## Maintainer environment setup

Create a GitHub Actions environment named `jetbrains-release`. Restrict its
deployment tags to `jetbrains/v*`, protect that tag namespace against movement
or untrusted creation, and configure the repository's release reviewers.
Ordinary plugin development uses the unsigned package and needs no credentials.

- Set the environment variable `JETBRAINS_SIGNING_CERTIFICATE` to the trusted
  public PEM certificate chain, with the Ferret signing leaf first, followed by
  its issuers in order. A self-signed author uses one PEM certificate.
  Verification checks the signer’s embedded chain and uses the final configured
  certificate as the trust anchor. Retain the original public chain for
  recovery of releases made with it.
- Set the environment secret `JETBRAINS_SIGNING_KEY` to its matching PEM
  private key. The job accepts an **unencrypted PEM** stored as a GitHub
  environment secret, writes it to a private temporary file for the signer,
  and removes the file on exit. Generate the key offline and keep its backup
  outside the checkout. [JetBrains signing instructions](https://plugins.jetbrains.com/docs/intellij/plugin-signing.html)
- Leave the environment variable `JETBRAINS_MARKETPLACE_ENABLED` unset or
  `false` through the first listing. For subsequent updates set the secret
  `JETBRAINS_MARKETPLACE_TOKEN` to a vendor-authorized permanent token from
  Marketplace **My Tokens**, then set the variable to `true`. The upload step
  uses bearer authentication. [Marketplace upload API](https://plugins.jetbrains.com/docs/marketplace/plugin-upload.html)

## First listing

1. Download both assets from the qualified GitHub Release. In their directory
   run `shasum -a 256 -c ferret-jetbrains-<version>-signed.zip.sha256`.
2. Install that signed ZIP in an isolated GoLand instance. Complete the native
   and embedded application [packaged smoke procedure](README.md#smoke-test-the-packaged-plugin).
   Record the digest, plugin and daemon versions, IDE build, and observations,
   including runtime discovery, Run, Debug inspection/stepping, Stop, relaunch,
   and Reload.
3. Sign in to JetBrains Marketplace, accept the Developer Agreement, and
   create or select the Ferret vendor profile. Choose **Upload plugin**, supply
   the signed ZIP, project description and relevant tags. Use the project's
   [Apache-2.0 license](../../LICENSE), [source](https://github.com/MontFerret/editorium),
   [project](https://ferretlang.org), and [issue tracker](https://github.com/MontFerret/editorium/issues).
4. Confirm the listing's Plugin XML ID is `org.ferretlang.jetbrains`. Record the
   submission and review status. Enable automation for the **next** stable
   version. The initial submission is performed once. [First submission](https://plugins.jetbrains.com/docs/marketplace/uploading-a-new-plugin.html)

## Recovery

Local transaction failures restore only owned manifest edits, staging, commit,
and tag when safe. Unexpected edits, changed refs, and concurrent commits are
preserved. Cancellation attempts bounded cleanup; a forcibly killed process
cannot run cleanup.

A push transport error is reconciled against remote `main`, the annotated tag
object, and its peeled commit. Matching intended refs mean success; confirmed
non-publication permits local rollback. Unknown or conflicting results retain
local recovery state and report the intended commit and tag object. Inspect
`git status`, `git reflog main`, and:

```sh
git ls-remote origin refs/heads/main 'refs/tags/jetbrains/v<version>' 'refs/tags/jetbrains/v<version>^{}'
```

Keep published tags intact. Resume only after inspecting the remote state,
using the original commit and annotated tag object in one
`git push --atomic --no-follow-tags`. Do not force updates, retag, or send
independent pushes. Resolve unexpected local changes separately before rerunning
the release command.

- If GitHub publication already succeeded, the workflow checks its tag, title,
  prerelease flag, asset names, signature, descriptor, commit and checksum.
  The read-only verification job downloads both original assets even when
  Marketplace upload is disabled. If a completed release appears after
  preflight, publication uses those assets and skips automatic Marketplace
  submission. On conflicting metadata
  or an incomplete draft, inspect the release and original run. Recover only
  the original verified assets from that attempt's `jetbrains-signed-<commit>-<attempt>`
  Actions artifact. Confirm its checksum and author signature against the
  protected certificate before finishing an incomplete draft. Escalate to a maintainer if
  those bytes cannot be established. Keep the published version and tag intact.
- After an upload error, inspect the vendor dashboard for the exact plugin ID,
  version, Stable channel, and pending or approved submission. A duplicate
  response or lost connection can mean that the first request landed. If a
  matching update is pending or visible, record its ID and status and stop.
  Investigate any discrepancy with the vendor before submitting again.
- If the version is absent, correct any token or permission issue and start
  a fresh **Release JetBrains plugin** workflow dispatch against the original
  tag. For example, run `gh workflow run release-jetbrains.yml --ref jetbrains/v0.1.0 -f confirm-absent=true`
  with the actual tag. The dispatch reruns qualification, requires an existing
  GitHub Release, and submits the verified original ZIP. Ordinary Actions
  reruns skip the upload. An accepted upload awaits Marketplace review and
  public availability. [Plugin updates](https://plugins.jetbrains.com/docs/marketplace/plugin-updates.html)
