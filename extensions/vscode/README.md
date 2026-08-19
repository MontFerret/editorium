# Ferret for Visual Studio Code

This package provides Visual Studio Code support for Ferret Query Language
files. It is under active development.

Opening a `.fql` file provides a declarative editing baseline without requiring
`ferretd`:

- syntax highlighting for current Ferret v2 constructs;
- line and block comments;
- bracket matching and automatic pair insertion;
- conservative brace-based indentation; and
- folding for structurally indented blocks.

The TextMate grammar is a resilient lexical fallback. It recognizes language
syntax, functions, namespaces, templates, and dialect-tagged query payloads,
but it does not parse or semantically analyze Ferret programs.

Language intelligence is provided by
[`ferretd`](https://github.com/MontFerret/ferretd) over the Language Server
Protocol. When `ferretd` advertises a capability, VS Code exposes it through
the standard language client. Current server releases can provide diagnostics,
completion, hover information, signature help, symbols and navigation,
semantic tokens, and document formatting. The extension does not implement
those features independently.

Language-server features currently require a Ferret document with a file URI.
Untitled Ferret documents still receive TextMate highlighting, but `ferretd`
does not yet accept their non-file document URIs.

Debugging and rich result viewers are not included.

## Run a Ferret file

Open a saved `.fql` file and use the editor Run button or **Ferret: Run File**.
If the file has unsaved changes, confirm **Save and Run** so the daemon executes
the saved version. When execution completes successfully, **Ferret Execution**
opens under **View → Output** without taking focus from the editor and shows the
result and elapsed time. Use **Ferret: Show Output** to reveal that channel
directly later.

The editor action changes to Cancel while the file is running, and **Ferret:
Cancel Execution** stops the active execution. Runtime and compilation errors
are written to the execution output with source locations when the daemon
provides them. Different files may execute concurrently.

## Bundled language server

The extension includes a compatible `ferretd` executable. No separate daemon
installation or `PATH` configuration is required on these targets:

- macOS ARM64 and x64;
- Linux ARM64 and x64; and
- Windows ARM64 and x64.

VS Code installs the platform-specific extension package for the extension
host. In Remote SSH, Dev Container, WSL, and Codespaces windows, the bundled
daemon therefore runs beside the extension and workspace on the remote host;
it does not communicate back to a daemon on the local UI machine.

`ferret.server.path` remains an advanced override for development and
troubleshooting:

```json
{
  "ferret.server.path": "/absolute/path/to/ferretd"
}
```

An empty path selects the bundled daemon. A non-empty path is authoritative:
if it is invalid, startup fails rather than silently falling back. Advanced
server arguments can be appended after the required `lsp` command:

```json
{
  "ferret.server.args": []
}
```

After changing either setting, run **Ferret: Restart Language Server**. The
extension never downloads or updates executables at activation time.

## Output and troubleshooting

The user-facing **Ferret Execution** channel contains query results and execution
failures. The separate **Ferret** channel contains daemon and language-server
diagnostics: whether the bundled daemon or configured override is active, its
version when available, effective arguments, lifecycle events, server stderr,
and startup failures.

Protocol tracing is disabled by default and can be enabled when troubleshooting:

```json
{
  "ferret.trace.server": "messages"
}
```

Use `verbose` to include protocol payload details and `off` to disable tracing.
Do not share verbose traces without checking them for document contents or
other sensitive data.

If the server fails to start:

1. Check the **Ferret** output channel for the underlying process error.
2. For the bundled daemon, reinstall the extension package matching the
   extension host platform.
3. For an override, run the configured executable with `lsp` in that extension
   host and correct `ferret.server.path` or `ferret.server.args`.
4. Run **Ferret: Restart Language Server**.

Syntax highlighting and the declarative editing baseline continue to work
while the server is unavailable.

## Development

Install dependencies from the repository root:

```sh
npm install
```

The VS Code source package can then be built and tested independently:

```sh
npm run build --workspace fql
npm test --workspace fql
```

The build bundles the language client and extension sources into
`extensions/vscode/out/extension.js`. It does not download a daemon.
Installation synchronizes the ferretd schemas selected by the root
`ferretd.json` into `shared/proto/`; client generation never reads an
editor-local copy. Use `npm run proto:sync` at the repository root to check the
schema cache, or add `-- --force` to refresh it.

To stage the pinned daemon for the current host, create its platform-specific
VSIX, or install that VSIX into the local VS Code instance, run:

```sh
npm run vscode:prepare
npm run vscode:package
npm run vscode:install
```

Each command accepts an explicit target, such as:

```sh
npm run vscode:package -- --target darwin-arm64
```

The package command prints and creates
`extensions/vscode/fql-<target>-<extension-version>.vsix`. It verifies the
official release checksum, the staged executable, the VSIX target and exact
contents, the Unix executable mode, and the daemon bytes/version when the
target is native. Downloads are cached under `.dist/`; the one selected binary
is staged under `extensions/vscode/bin/`. Both locations and all VSIX files are
ignored by Git.

`ferretd.json` at the repository root is the sole bundled-daemon version pin.
See [`RELEASING.md`](RELEASING.md) for target artifacts and future publication
handoff.

Real-server integration tests are a separate, explicit suite. Point
`FERRETD_TEST_PATH` at the pinned executable and run:

```sh
FERRETD_TEST_PATH=/absolute/path/to/ferretd npm run test:integration --workspace fql
```

The integration command fails when the override is missing or unusable. CI
stages the daemon selected by `ferretd.json` and runs this suite in addition to
the fast unit suite and installed-VSIX bundled-server smoke test. Both labels
pin VS Code 1.95.0, the extension's compatibility baseline, so test-host
behavior does not drift with the latest Stable release.

## Run and debug

1. Open the repository root in Visual Studio Code.
2. Either run `npm run vscode:prepare` to stage the pinned bundled daemon, or
   configure `ferret.server.path` in the Extension Development Host to point
   to a locally built daemon.
3. Press `F5` and select **Run Ferret Extension** if prompted.
4. Open a file ending in `.fql` and inspect the **Ferret** output channel.
5. After rebuilding `ferretd`, run **Ferret: Restart Language Server** without
   reloading the Extension Development Host.

Fixtures under `test/fixtures` cover valid and deliberately incomplete Ferret
documents.
