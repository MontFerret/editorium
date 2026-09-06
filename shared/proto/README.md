# Shared protocol schemas

This directory contains editor-independent Protocol Buffer inputs. Extension
client generators read schemas from here and keep their generated language
bindings inside their own extension directories.

`ferretd/` is synchronized from the exact ferretd tag selected by the root
`ferretd.json`. Its contents and `.ferretd-version` marker are generated and
must not be committed. Run `make proto-sync` from the repository root, or use
`make proto-sync FORCE=1` to atomically replace the managed tree even when the
marker already matches. Generate or verify either integration's committed
client with:

```sh
make proto-generate vscode
make proto-check vscode
make proto-generate jetbrains
make proto-check jetbrains
```

`google/rpc/status.proto` is a committed third-party Google API schema shared
by all editor integrations. It is not owned or updated by the ferretd
synchronizer.

The pinned execution schema includes an optional `working_directory`. Client
generators must preserve its presence: an omitted field uses the daemon's
workspace root, while a present value selects an explicit runtime filesystem
root. Source identity continues to be derived only from the workspace.

The JetBrains generator invokes Buf 1.72.0 with pinned Java 36.1 and gRPC Java
1.84.0 remote plugins. It writes a sibling staging directory before an atomic
replacement; its check command uses a temporary tree and leaves the checkout
untouched. Generated Java sources are owned exclusively by this workflow and
must not be hand-edited.
