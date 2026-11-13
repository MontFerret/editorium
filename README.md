# Editorium

Editorium is the monorepo for Ferret editor integrations. Each editor package
owns its adapter-specific implementation; language intelligence remains in
Ferret and its language server.

## Repository layout

- [`extensions/vscode/`](extensions/vscode/README.md) — Visual Studio Code
  support for Ferret Query Language files.
- [`extensions/jetbrains/`](extensions/jetbrains/README.md) — the Kotlin-based
  JetBrains IDE plugin, `.fql` file recognition, native LSP integration,
  Run-console execution, native debugging, and bundled daemon distribution.
- `shared/` — editor-independent inputs. Protocol schemas live under
  `shared/proto/`; generated clients remain owned by each extension.
- `tools/editorium/` — the Go implementation behind the repository Make
  interface, including integration dispatch, daemon/protocol acquisition,
  packaging, CI matrices, and releases.

Future editor integrations belong under `extensions/`. Adding one requires an
explicit Go catalog/adapter entry; it does not change the public Make commands.

Every extension runs its full test suite on Linux, macOS, and Windows for
relevant pushes and pull requests. CI also builds, lints, packages, and verifies
each extension. VS Code checks all six native VSIX artifacts and exercises the
installed Linux x64 package. JetBrains verifies its universal ZIP and checks
IDE compatibility with Plugin Verifier. Its real-process suite builds the independent
Go module in `fixtures/wire-host` (Go 1.26.1 or newer) and runs embedded-application
queries with the current-host daemon.

## Repository commands

GNU Make is the documented monorepo interface. Run `make help` for the concise
command list and `make extensions` for the sorted integration catalog.

```sh
make prepare                 # prepare every integration
make build                   # build every integration
make test                    # test Go tooling and every integration
make lint                    # format/vet Go and lint every integration
make clean                   # remove all integration outputs and shared caches
```

Safe commands also accept one or more integration names, for example
`make build vscode` or `make test vscode`. A targeted clean removes only that
integration's outputs; unscoped `make clean` additionally removes `.dist/` and
the synchronized `shared/proto/ferretd/` cache. Neither form removes
`node_modules` or committed generated clients.

Go 1.26 implements the repository tooling. Node.js 22 or newer and npm provide
the VS Code dependency and native-tool layer. Install that layer explicitly
after cloning:

```sh
npm --prefix extensions/vscode ci
```

Installing dependencies does not synchronize schemas, download `ferretd`, or
run repository preparation. The VS Code manifest and lockfile own that Node
toolchain locally; the repository root has no npm metadata. JetBrains plugin
development additionally requires a JDK 21 or newer to run Gradle. The isolated
Gradle project automatically provisions the Java 25 toolchain required by
IntelliJ Platform 2026.2 and 2026.3. Use Make for normal repository operations.

Target an individual integration with the same public commands:

```sh
make build jetbrains
make lint jetbrains
make test jetbrains
make package jetbrains
```

The JetBrains package is created as
`extensions/jetbrains/build/distributions/ferret-jetbrains-0.1.0.zip`. It
contains Ferret language and `.fql` file-type registration plus all supported
native `ferretd` binaries. Local `.fql` files lazily activate a project-wide
JetBrains native LSP client that runs the matching bundled `ferretd lsp` process.
JetBrains owns the process and protocol lifecycle, while `ferretd` owns the
language behavior. Ferret Run configurations use a separate authenticated,
project-scoped execution daemon and display terminal JSON results and failures
in the Run console. The project base, or source parent when no base exists, is
the local compilation workspace. Run and Debug use the configured daemon default or an
exact runtime name. An optional native working directory resolves on the plugin
host. Wire forwards an explicit directory to the application verbatim, and a
blank field uses that application's default. An unavailable runtime fails the launch.
Each Debug session runs an independent `ferretd dap` process and provides
native XDebugger breakpoints, control commands, stacks, and
source navigation. Suspended frames provide lazy Locals/Parameters scopes,
typed expandable values, expression evaluation, and native watches, including
caller-frame inspection within the daemon's supported limits.

Run and Debug accept explicitly selected lowercase `.fql` regular files beneath
discovery-excluded directories such as `.tmp` and `testdata`, including nested
Go modules. Selection preserves the original source identity and compilation
workspace; it does not discover neighboring excluded files. Workspace containment
and the daemon's nested-symlink restrictions still apply.

## Protocol schemas

[`ferretd.json`](ferretd.json) is the sole version pin for both the daemon
bundled in distributions and the ferretd protocol schemas used to generate
editor clients. The current pin is `1.0.0-alpha.11`, which advertises API 1.3.
Both editors request API 1.1 for local execution and accept API major 1 with
minor 1 or later. JetBrains uses API 1.3 for catalog-based runtime selection.
Debug additionally checks its own adapter’s `supportsFerretRuntimeSelection`
capability for a configured file or explicit selector, including `local`. See the
[alpha.11 validation record](extensions/jetbrains/docs/debugger-validation.md#november-12-2026-ferretd-alpha11-migration)
for release availability and integration checks.

The pinned `proto/ferretd/` tree is cached under
`shared/proto/ferretd/`; its files and `.ferretd-version` marker are ignored by
Git. `shared/proto/google/rpc/status.proto` is a separately owned, committed
third-party input.

```sh
make proto-sync
make proto-sync FORCE=1
make proto-generate vscode
make proto-check vscode
make proto-generate jetbrains
make proto-check jetbrains
```

Synchronization is a no-op when the marker and required schemas match the pin.
A forced sync atomically replaces the entire managed tree. Failed downloads,
validation, or extraction preserve the prior cache. Generation writes the
committed client owned by the selected extension; checking generates into a
temporary tree and reports drift without modifying the checkout. JetBrains Java
output lives under `extensions/jetbrains/src/main/generated/` and must not be
edited by hand.

## VS Code distributions

Packaging and installation require one explicit integration and default to the
current host target:

```sh
make prepare vscode
make package vscode
make package vscode TARGET=linux-arm64
make install vscode
make install vscode CODE=code-insiders
```

The adapter verifies the pinned official release checksum, safe bounded archive
extraction, staged executable, VSIX target and exact contents, manifest version,
bundled daemon bytes, Unix executable mode, and native `ferretd --version`
output. Downloads live under `.dist/`; staged executables live under
`extensions/vscode/bin/`, and deterministic VSIX files live under
`extensions/vscode/dist/`. See
[`extensions/vscode/RELEASING.md`](extensions/vscode/RELEASING.md) for the
target matrix and release contract.

## JetBrains distribution

The Ferret plugin supports IntelliJ IDEA and GoLand on the 2026.2 and 2026.3
release lines. It compiles against IDEA 2026.2.0.1 with Java 25 bytecode and
retains minimum build `262`. The plugin descriptor has no upper build bound;
future IDE releases are not thereby verified. Plugin Verifier explicitly checks
IDEA 2026.2.0.1 and 2026.3, and GoLand 2026.2.4 and 2026.3. See the
[JetBrains compatibility matrix](extensions/jetbrains/README.md#ide-compatibility)
and [validation evidence](extensions/jetbrains/docs/debugger-validation.md)
for exact builds and the separate packaged-plugin smoke-test status.

The target-neutral JetBrains archive bundles the pinned daemon for macOS,
Linux, and Windows on arm64 and x64. Gradle invokes the shared Editorium
acquisition command before preparing the production plugin sandbox, stages the
verified matrix under `extensions/jetbrains/build/generated/ferretd/`, and
places it at `ferretd/<platform>/<architecture>/` beside the plugin JAR.

```sh
make prepare jetbrains
make package jetbrains
make package-check jetbrains
```

The package check verifies the descriptor in the shipped plugin JAR, the
complete six-target matrix against the verified daemon release, the version
marker, Unix executable modes, and native `ferretd --version` output. Downloads remain
cached under `.dist/`; no daemon binary is committed to Git.

## JetBrains releases

Maintainers run `make release jetbrains <version>` from a clean, synchronized
`main` after committing `pluginVersion` in the JetBrains Gradle properties.
The command qualifies the pinned daemon and pushes the annotated
`jetbrains/v<version>` tag. CI repeats strict qualification on three operating
systems before signing the universal ZIP and publishing it with its SHA-256 to
GitHub Releases. Exact stable plugin versions can subsequently go to the
JetBrains Marketplace after manual first-listing bootstrap.

The current alpha.11 daemon fails suspended Wire host-loss qualification. The
packaged GoLand walkthrough remains pending. Maintainer setup, bootstrap and
recovery are in the [JetBrains release guide](extensions/jetbrains/RELEASING.md).

## Update ferretd

1. Change the single `ferretd` version in `ferretd.json`.
2. Run `make proto-sync FORCE=1`.
3. Run `make proto-generate vscode` and `make proto-generate jetbrains`, then
   review both generated-client changes.
4. Run `make lint`, `make test`, `make package vscode`, and
   `make package jetbrains`.
5. Commit the pin, generated clients, and any compatibility changes; do not
   commit `shared/proto/ferretd/`, `.dist/`, staged binaries, or VSIX files.
