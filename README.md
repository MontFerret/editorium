# Editorium

Editorium is the monorepo for Ferret editor integrations. Each editor package
owns its adapter-specific implementation; language intelligence remains in
Ferret and its language server.

## Repository layout

- [`extensions/vscode/`](extensions/vscode/README.md) — Visual Studio Code
  support for Ferret Query Language files.
- [`extensions/jetbrains/`](extensions/jetbrains/README.md) — the Kotlin-based
  JetBrains IDE plugin, `.fql` file recognition, native LSP integration, and
  bundled daemon distribution.
- `shared/` — editor-independent inputs. Protocol schemas live under
  `shared/proto/`; generated clients remain owned by each extension.
- `tools/editorium/` — the Go implementation behind the repository Make
  interface, including integration dispatch, daemon/protocol acquisition,
  packaging, CI matrices, and releases.

Future editor integrations belong under `extensions/`. Adding one requires an
explicit Go catalog/adapter entry; it does not change the public Make commands.

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
IntelliJ Platform 2026.2. Use Make for normal repository operations.

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
language behavior. Execution and debugging remain deferred.

## Protocol schemas

[`ferretd.json`](ferretd.json) is the sole version pin for both the daemon
bundled in distributions and the ferretd protocol schemas used to generate
editor clients. The pinned `proto/ferretd/` tree is cached under
`shared/proto/ferretd/`; its files and `.ferretd-version` marker are ignored by
Git. `shared/proto/google/rpc/status.proto` is a separately owned, committed
third-party input.

```sh
make proto-sync
make proto-sync FORCE=1
make proto-generate vscode
make proto-check vscode
```

Synchronization is a no-op when the marker and required schemas match the pin.
A forced sync atomically replaces the entire managed tree. Failed downloads,
validation, or extraction preserve the prior cache. Generation writes the
committed extension client; checking generates into a temporary tree and
requires byte-for-byte equality.

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

The package check verifies the complete matrix, version marker, staged bytes,
Unix executable modes, and native `ferretd --version` output. Downloads remain
cached under `.dist/`; no daemon binary is committed to Git.

## Update ferretd

1. Change the single `ferretd` version in `ferretd.json`.
2. Run `make proto-sync FORCE=1`.
3. Run `make proto-generate vscode` and review generated client changes.
4. Run `make lint`, `make test`, `make package vscode`, and
   `make package jetbrains`.
5. Commit the pin, generated clients, and any compatibility changes; do not
   commit `shared/proto/ferretd/`, `.dist/`, staged binaries, or VSIX files.
