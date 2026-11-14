# Execution client boundary

A daemon **Session** owns a runtime binding, a compiled plan, and its immutable
source snapshot. Its parameter list contains bind names. An **Execution** is a
one-shot invocation with its own parameter values, output options, and optional
runtime filesystem root.

## Launch preparation

The Run command preserves the selected document across Save and Run. At
admission it captures resource-scoped settings, command overrides, and the
picker selection. The manager reserves the document and window activity before
awaiting runtime discovery. Concurrent documents can share generation startup,
catalog discovery, and workspace registration. Each launch can stop waiting
independently.

Run resolves its exact selector against the catalog owned by its admitted
generation. It verifies that generation's config fingerprint before Session
acquisition or reuse. The workspace registry supplies the source path and the
root that registered it. Native directory overrides resolve on the extension
host. Wire receives literal application paths. An omitted directory uses the
provider's default.

## Protocol and ownership

The execution client binds to a single daemon connection. CreateSession sends
the requested selector and the workspace-relative source, with a 30-second
acquisition/compilation deadline. The acknowledged runtime must match the
resolved name on API 1.3+. Only built-in default execution on a compatible old
daemon accepts an absent acknowledgment. A malformed creation response with a
recoverable ID triggers rollback on the original connection.

Native Sessions can be reused in the same generation for an unchanged document,
workspace, source, and resolved runtime. Saving retires the cached plan. A Run
already using it releases its reference after its Execution closes. Each Wire
Run owns a fresh Session until cleanup, including when preparation stops early.
Parameters and directories are encoded at CreateExecution for both providers.

The manager establishes WatchExecution before RunExecution. The watch supplies
ordered lifecycle snapshots, including the terminal output. Stop cancels
in-flight launch RPCs and explicitly cancels an existing Execution. Cleanup
closes the Execution before releasing its Session, using independent five-second
RPC deadlines. The admission covers cleanup. Connection loss invalidates IDs and
requires a new explicit Run. The Wire application owns its engine and process.

ExecutionFeedbackController renders the resolved provider and runtime before
acquisition, elapsed time, diagnostics, results and any partial output in
**Ferret Execution**. Cleanup errors are reported separately from the retained
result. The **Ferret** diagnostic channel records transport and cleanup details.
