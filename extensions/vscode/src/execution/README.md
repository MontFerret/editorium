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
daemon accepts an absent acknowledgment. API 1.4 creation carries a fresh
acquisition UUID. The daemon echoes it and accepts cancellation by workspace ID and UUID even before
publication. A lost, late, or malformed reply is reconciled on the original
connection. Wire requires this capability. A mismatched Execution parent causes
the manager to retire the known Session and its children.

Native Sessions can be reused in the same generation for an unchanged document,
workspace, source, and resolved runtime. Saving retires the cached plan. The
manager checks the saved file digest before reuse and across compilation,
including after external edits. A Run already using the plan releases its
reference after its Execution closes. Each Wire
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
