# Releasing Ferret for JetBrains IDEs

## Qualification and tagging

Commit the plugin's intended full SemVer as `pluginVersion` in
`gradle.properties`. Gradle and the release tool read that property.
`ferretd.json` independently pins the daemon bundled in both editors.
Before tagging, run the following from the repository root.

```sh
make test
make lint
make package jetbrains
make package-check jetbrains
FERRET_TEST_PASSIVE_HOST_LOSS=1 make test jetbrains
```

The strict test kills the owned Wire application at a confirmed breakpoint and
requires a failing exit without sending Continue. The published alpha.11 daemon
currently times out. A corrected official daemon must pass that assertion with
a matching Wire fixture. Update the root pin, compare fixture module versions,
regenerate/check affected clients, and validate both editors when adopting it.
Track interactive GoLand smoke separately in the [validation record](docs/debugger-validation.md).

Once the workflow and version source are merged into `main`, run `make release jetbrains <version>` from clean `main` tracking
`origin/main`. The command checks the tracked version against HEAD, rejects an
existing tag, runs Go tooling, preparation, build, lint, strict tests, packaging
and package checks, then rechecks the checkout. It creates the annotated
`jetbrains/v<version>` tag at that commit and pushes only the tag.

Tag CI validates the version and runs the full JetBrains tests with the owned
Wire fixture on Linux, macOS, and Windows. It also checks all four configured
IDE builds, packages the plugin, and transfers the selected ZIP and digest.
After qualification, the protected job signs that archive with the Marketplace
ZIP Signer, verifies the author certificate, packaged descriptor and source
commit, six pinned daemon binaries, and native executable. It enforces a
400,000,000-byte ceiling and publishes exactly these GitHub assets:

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
  public PEM certificate chain, with the signing certificate first. Retain its
  identity for verification of historical releases.
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

- If GitHub publication already succeeded, the workflow checks its tag, title,
  prerelease flag, asset names, signature, descriptor, commit and checksum.
  Existing releases supply the original signed bytes. On conflicting metadata
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
