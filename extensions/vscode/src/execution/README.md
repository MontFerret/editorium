# Execution client boundary

The daemon owns two related resources. A **Session** is one immutable compiled
Ferret program associated with a retained workspace document. An
**Execution** is one isolated, one-shot invocation of that Session with its own
runtime state and JSON-shaped parameter bindings.

Code outside this directory consumes the domain types in `types.ts`. Generated
protobuf messages, numeric protocol enums, gRPC errors, and stream objects stay
behind `FerretExecutionClient` so future editor features have a stable contract.

`runExecution()` starts or schedules daemon work and returns the daemon's
current snapshot; it does not wait for completion. `watchExecution()` observes
ordered lifecycle events. Disposing a watch only stops local observation,
while `cancelExecution()` separately requests daemon-side cancellation.

`FerretExecutionManager` is the editor-facing owner of these resources. It
resolves saved, file-backed Ferret documents through the current daemon
workspace registry and caches one Session per unchanged document. Each call to
`run()` creates a new Execution from that Session, establishes its watch before
starting it, and keeps at most one extension-managed Execution active for that
document. Different documents remain independent and may run concurrently.

Saving a document removes its Session from the reusable cache. An invalidated
Session that still owns an active immutable Execution is closed after that
Execution finishes, so saving does not cancel the current invocation. Workspace
replacement or daemon-generation loss discards every affected daemon identity;
future runs resolve the new workspace and rebuild Sessions lazily. Dirty,
untitled, non-file, and non-Ferret documents are never sent to the daemon.

The VS Code Run File and Cancel Execution commands are adapters over that
manager rather than additional lifecycle owners. Run File always executes the
saved workspace version of the active document. A dirty document must complete
the explicit Save and Run flow first; the manager's save listener then retires
the cached Session before the command asks it to run. The command layer neither
invalidates Sessions nor observes daemon streams itself. One document can have
only one extension-managed active Execution, while different documents may run
concurrently.

`ExecutionFeedbackController` is the only user-interface observer of manager
events. It renders daemon-provided JSON output in the **Ferret Execution**
channel, derives the global running count from the manager, and owns the one
transient status-bar item. It never opens a daemon watch. Detailed transport
and rendering failures remain in the separate **Ferret** diagnostic channel.
