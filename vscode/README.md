# Ferret for Visual Studio Code

This package provides Visual Studio Code support for Ferret Query Language
files. It is under active development.

The current foundation registers `.fql` files as the `ferret` language. Syntax
highlighting, language-server integration, diagnostics, completion, formatting,
and other language features are not included yet.

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
4. Confirm that the language mode shown by VS Code is **Ferret**.

The extension entry point intentionally performs no runtime work at this
milestone.
