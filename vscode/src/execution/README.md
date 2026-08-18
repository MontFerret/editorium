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
