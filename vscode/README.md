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

Language-server integration, diagnostics, completion, hover information,
semantic intelligence, formatting, debugging, and execution are not included
yet. Those features will be provided through later `ferretd` integrations.

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

The package command creates `vscode/fql-0.1.0.vsix`. Generated output and VSIX
files are ignored by Git.

## Run and debug

1. Open the repository root in Visual Studio Code.
2. Press `F5` and select **Run Ferret Extension** if prompted.
3. In the Extension Development Host, open a file ending in `.fql`.
4. Confirm that the language mode shown by VS Code is **Ferret** and inspect
   the fixtures under `test/fixtures`.

The extension entry point intentionally performs no runtime work.
