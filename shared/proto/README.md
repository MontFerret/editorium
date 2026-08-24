# Shared protocol schemas

This directory contains editor-independent Protocol Buffer inputs. Extension
client generators read schemas from here and keep their generated language
bindings inside their own extension directories.

`ferretd/` is synchronized from the exact ferretd tag selected by the root
`ferretd.json`. Its contents and `.ferretd-version` marker are generated and
must not be committed. Run `make proto-sync` from the repository root, or use
`make proto-sync FORCE=1` to atomically replace the managed tree even when the
marker already matches. Generate or verify an integration's committed client
with `make proto-generate vscode` or `make proto-check vscode`.

`google/rpc/status.proto` is a committed third-party Google API schema shared
by all editor integrations. It is not owned or updated by the ferretd
synchronizer.
