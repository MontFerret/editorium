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

Debugging and query execution are not included.

## Install ferretd

Install `ferretd` separately from its
[GitHub releases](https://github.com/MontFerret/ferretd/releases) or build it
from source. By default the extension starts:

```text
ferretd lsp
```

The executable is resolved from the `PATH` of the extension host. In a remote
SSH, Dev Container, WSL, or Codespaces window, install or configure `ferretd`
in that remote environment rather than on the local UI machine.

Use an explicit path when `ferretd` is not on `PATH`:

```json
{
  "ferret.server.path": "/absolute/path/to/ferretd"
}
```

An empty path restores `PATH` lookup. Advanced server arguments can be
appended after the required `lsp` command:

```json
{
  "ferret.server.args": []
}
```

After changing either setting, run **Ferret: Restart Language Server**. The
extension deliberately does not download, update, or enforce a compatible
version of `ferretd`.

## Output and troubleshooting

Select **Ferret** under **View → Output** to inspect the resolved executable,
effective arguments, lifecycle events, server stderr, and startup failures.
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
2. Run the configured executable with `lsp` in the same local or remote
   environment where the extension runs.
3. Correct `ferret.server.path` or `ferret.server.args`.
4. Run **Ferret: Restart Language Server**.

Syntax highlighting and the declarative editing baseline continue to work
while the server is unavailable.

## Development

Install dependencies from the repository root:

```sh
npm install
```

The VS Code package can then be managed independently:

```sh
npm run build --workspace vscode
npm test --workspace vscode
npm run package --workspace vscode
npm run package:check --workspace vscode
```

The build bundles the language client and extension sources into
`vscode/out/extension.js`. The package command creates
`vscode/fql-0.1.0.vsix`. Generated output and VSIX files are ignored by Git.

The real-server integration test is enabled when `FERRETD_TEST_PATH` points to
an executable:

```sh
FERRETD_TEST_PATH=/absolute/path/to/ferretd npm test --workspace vscode
```

CI downloads and verifies a pinned `ferretd` release rather than relying on an
ambient installation.

## Run and debug

1. Open the repository root in Visual Studio Code.
2. Press `F5` and select **Run Ferret Extension** if prompted.
3. In the Extension Development Host, set `ferret.server.path` to a locally
   built `ferretd` when it is not already on `PATH`.
4. Open a file ending in `.fql` and inspect the **Ferret** output channel.
5. After rebuilding `ferretd`, run **Ferret: Restart Language Server** without
   reloading the Extension Development Host.

Fixtures under `test/fixtures` cover valid and deliberately incomplete Ferret
documents.
