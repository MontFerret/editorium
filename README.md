# Editorium

Editorium is the monorepo for Ferret editor integrations. Each editor package
owns its adapter-specific implementation; language intelligence remains in
Ferret and its language server.

## Packages

- [`vscode/`](vscode/README.md) — Visual Studio Code support for Ferret Query
  Language files.

Future editor integrations can live alongside `vscode/` without introducing a
shared editor runtime before one is needed.

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
provides it.
