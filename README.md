# Editorium

Editorium is the monorepo for Ferret editor integrations. Each editor package
owns its adapter-specific implementation; language intelligence remains in
Ferret and its language server.

## Repository layout

- [`extensions/vscode/`](extensions/vscode/README.md) — Visual Studio Code
  support for Ferret Query Language files.
- `shared/` — editor-independent inputs that may be consumed by more than one
  integration. Protocol schemas live under `shared/proto/`; generated clients
  remain owned by each extension.
- `scripts/` — repository-level acquisition and validation tooling.

Future editor integrations belong under `extensions/`. Editor-specific source,
generated clients, packaging, and tests stay with their extension rather than
forming a shared editor runtime before one is needed.

## Protocol schemas

[`ferretd.json`](ferretd.json) is the sole version pin for both the daemon
bundled in distributions and the ferretd protocol schemas used to generate
editor clients. `npm install` and `npm ci` automatically download the
`proto/ferretd/` tree from that exact `v<version>` tag into
`shared/proto/ferretd/`. The synchronized files and their version marker are
ignored by Git; `shared/proto/google/rpc/status.proto` is a separately owned,
committed third-party input shared by editor integrations.

Run synchronization explicitly when needed:

```sh
npm run proto:sync
npm run proto:sync -- --force
```

The first command is a no-op when the local marker and required schemas match
`ferretd.json`. `--force` downloads and atomically replaces the managed schema
tree even when the version is unchanged. A failed download or extraction keeps
the previous tree intact.

## Development

Node.js 22 or newer and npm are required for the JavaScript workspaces.

```sh
npm install
npm run build
npm test
npm run package
npm run package:check
```

The root commands run the corresponding script in every npm workspace that
provides it. Committed generated clients are verified by workspace tests and
can be regenerated from the synchronized inputs with:

```sh
npm run proto:generate --workspace fql
npm run proto:check --workspace fql
```

VS Code distribution commands acquire the explicitly pinned `ferretd` release,
verify its published checksum, and default to the current host target:

```sh
npm run vscode:prepare
npm run vscode:package
npm run vscode:install
```

Pass `--target <target>` after `--` for an explicit supported target, for
example `npm run vscode:package -- --target linux-arm64`. Generated downloads,
staged executables, and VSIX files are ignored by Git. See
[`extensions/vscode/RELEASING.md`](extensions/vscode/RELEASING.md) for the
distribution matrix and release procedure.

## Update ferretd

1. Change the single `ferretd` version in `ferretd.json`.
2. Run `npm run proto:sync`.
3. Run `npm run proto:generate --workspace fql` and review generated client
   changes.
4. Run `npm test`, `npm run package`, and `npm run package:check`.
5. Commit the version, generated clients, and any compatibility changes; do not
   commit `shared/proto/ferretd/`.
