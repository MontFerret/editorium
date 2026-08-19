# Shared protocol schemas

This directory contains editor-independent Protocol Buffer inputs. Extension
client generators read schemas from here and keep their generated language
bindings inside their own extension directories.

`ferretd/` is synchronized from the exact ferretd tag selected by the root
`ferretd.json`. Its contents and `.ferretd-version` marker are generated and
must not be committed. Run `npm run proto:sync`, or add `-- --force` to replace
the managed tree even when the marker already matches.

`google/rpc/status.proto` is a committed third-party Google API schema shared
by all editor integrations. It is not owned or updated by the ferretd
synchronizer.
