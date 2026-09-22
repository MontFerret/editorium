# M3 T2 debugger validation

## September 22, 2026: alpha.8 follow-up

The sole repository pin is now `1.0.0-alpha.8`. The
[upstream release](https://github.com/MontFerret/ferretd/releases/tag/v1.0.0-alpha.8)
fixes the first-executable-statement breakpoint defect described in the
historical alpha.7 report below.

On revision `b861896`, [JetBrains CI](https://github.com/MontFerret/editorium/actions/runs/35755685043)
passed unit/platform tests and build, verification, and packaging. All three OS
integration jobs (Ubuntu, macOS, and Windows) ran 20 tests with one failure:
`alpha7SkipsVerifiedBreakpointAtFirstExecutableStatement`. That characterization
expected the old defect and awaited termination without continuing the newly
correct breakpoint stop. The stale expectation belongs to Editorium.

The replacement `hitsVerifiedBreakpointAtFirstExecutableStatement` checks
verification, the breakpoint reason and hit identity, the original source at
line 1/column 1, and confirmed suspension with `stopOnEntry=false`. It then
continues and checks result `1`, exit code 0, no further stops or session errors,
and adapter exit. Production behavior, the daemon pin, deadlines, and CI
configuration are unchanged by this correction.

Local follow-up on macOS arm64 with Temurin JDK 25.0.4.1 and IntelliJ Platform
2026.2.0.1:

| Check | Status | Evidence |
| --- | --- | --- |
| Alpha.8 acquisition | PASS | `make prepare jetbrains` verified and staged all six release targets; native version reports `1.0.0-alpha.8`. |
| First-statement regression | PASS | Focused `ferretdIntegrationTest` ran the replacement test against the acquired alpha.8 binary supplied by `FERRETD_TEST_PATH`. |
| Complete JetBrains suite | PASS | `make test jetbrains`: protocol drift check, 152 unit/platform tests, and 20 real-daemon tests; no failures or skips. |
| Final review | PASS | Complete four-file diff reviewed; `git diff --check` passed. |
| Hosted CI for this correction | NOT RUN | Changes are local; Ubuntu, macOS, and Windows must pass on the updated PR revision before declaring hosted CI resolved. |

The focused command, run from the repository root with `JAVA_HOME` set to the
JDK 25 installation, was:

```sh
FERRETD_TEST_PATH="$PWD/.dist/ferretd/1.0.0-alpha.8/darwin-arm64/extracted/ferretd" \
  extensions/jetbrains/gradlew -p extensions/jetbrains ferretdIntegrationTest \
  --tests org.ferretlang.jetbrains.integration.FerretDapIntegrationTest.hitsVerifiedBreakpointAtFirstExecutableStatement
```

The manual sandbox limitations below remain unresolved. The September 16
results, including alpha.7's failure and package evidence, remain historical
evidence rather than claims about alpha.8.

## September 16, 2026: historical alpha.7 validation

Recorded September 16, 2026, on macOS arm64 with JDK 25 and IntelliJ Platform
2026.2.0.1 (`IU-262.8665.337`). The Editorium debugger core is implemented.
Unconditional milestone sign-off remains blocked by the upstream first-statement
breakpoint defect and the unavailable manual sandbox pass described below.

## Feature matrix

PASS means the cited automated checks passed. It does not imply a manual UI
gesture or execution on another operating system.

| Feature | Status | Evidence |
| --- | --- | --- |
| alpha.7 daemon pin | PASS | Sole root pin; six verified release artifacts; ZIP package check. |
| Debug executor | PASS | Registered runner accepts the existing configuration; native runner saves edited source and starts XDebugger. |
| DAP process lifecycle | PASS | Per-launch process probes, real adapter exit checks, cancellation during creation, and forced-destruction fallback. |
| Initialize/launch handshake | PASS | Controlled LSP4J adapter verifies pending launch, initialized, initial replacements, configurationDone, and launch completion. |
| Initial breakpoints | FAIL | Normal persisted breakpoints pass; alpha.7 skips a verified breakpoint at the first executable statement. Upstream finding below. |
| Breakpoint verification | PASS | Unverified success is nonfatal; relocation retains the original gutter line; upstream messages retained. |
| Live breakpoint edits | PASS | Complete/empty replacements, reordered replies, retained IDs, real live replacement, native enable/disable/mute callbacks. |
| Initial synchronization failure | PASS | Failure and timeout mark an error, clean up, and never send configurationDone. |
| Live synchronization failure | PASS | Controlled failure ends only the affected session. |
| Pause | PASS | Real running query and native Debug session confirm a pause stop. |
| Continue | PASS | Real execution completes; native continuation after breakpoint removal; no continued event required. |
| Step over | PASS | Exact next mapping and real function-query stepping. |
| Step into | PASS | Exact stepIn mapping, real callee and caller stack frames. |
| Step out | PASS | Exact stepOut mapping and return to caller. |
| Confirmed suspension | PASS | Only stopped creates context; fast stops beat late replies; rejection restores confirmed state; removed committed stops remain suspended. |
| Stack frames | PASS | Requested offsets, 100-frame pages, totals, ordered frame IDs/names, generation identity, obsolete containers, stale responses. |
| Source navigation | PASS | Native source navigation; relative paths; missing, invalid, and reference-only sources are unavailable. |
| Unicode positions | PASS | UTF-16 column/offset platform checks; real Unicode source and native navigation. |
| Runtime working directory | PASS | Shared canonical input fixtures and real Debug reads from an independent external runtime directory. |
| Debug console | PASS | Exact output text/category tests, real results/exit codes, native no-input handler, no evaluator. |
| Stop / cleanup | PASS | Stop before/during startup and synchronization; repeated cleanup; malformed stream/EOF; normal completion; bounded destruction. |
| Two Debug sessions | PASS | Independent real process IDs; stopping one leaves the other inspectable and resumable. |
| Run + Debug | PASS | Real gRPC Run and DAP Debug execute concurrently with independent cancellation and processes. |
| Project lifetime | PASS | Parent-job cancellation while suspended and before native startup; heavy project fixtures dispose native UI resources. |
| M1/M2 regression | PASS | Existing JetBrains LSP/Run/configuration/refactoring tests; real Run lifecycle tests; VS Code real LSP diagnostics/completion/hover/definition/formatting suite. |
| Plugin Verifier | PASS | Compatible with IU-262.8665.337; final implementation has no reported deprecated, internal, override-only, removal, or experimental API usages. |
| Manual sandbox matrix | BLOCKED | IDE launches, but the computer-control tool cannot target its Java application window. |

The primary test evidence is in
[controlled session tests](../src/test/kotlin/org/ferretlang/jetbrains/debugger/FerretDapSessionTest.kt),
[stack tests](../src/test/kotlin/org/ferretlang/jetbrains/debugger/FerretExecutionStackTest.kt),
[platform tests](../src/test/kotlin/org/ferretlang/jetbrains/debugger/FerretDebuggerPlatformTest.kt),
[real DAP tests](../src/test/kotlin/org/ferretlang/jetbrains/integration/FerretDapIntegrationTest.kt),
[native Debug tests](../src/test/kotlin/org/ferretlang/jetbrains/integration/FerretNativeDebugIntegrationTest.kt),
and [Run integration tests](../src/test/kotlin/org/ferretlang/jetbrains/integration/FerretExecutionIntegrationTest.kt).

## Upstream failure

Owner: **ferretd**, with the Ferret debugger's entry/resume semantics involved.
With the pinned alpha.7 adapter, launch this source using `stopOnEntry=false`
and an initial breakpoint at line 1:

```fql
LET value = 1
RETURN value
```

The setBreakpoints response verifies the breakpoint. After configurationDone,
the adapter returns `1`, exits 0, and never emits a breakpoint stopped event.
The same breakpoint at line 2 works. Inspection of upstream
`internal/dap/events.go` shows the adapter suppresses the entry event and calls
ContinueSession; that resume skips the first location. Editorium sends the
approved handshake and does not resume independently during launch.

`alpha7SkipsVerifiedBreakpointAtFirstExecutableStatement` explicitly
characterizes this released defect. Its passing result is evidence of the
limitation, not evidence that first-statement breakpoints work. An upstream fix
must make this case stop normally, then replace that characterization with the
positive regression assertion and reevaluate the sole daemon pin. No workaround
or upstream source change was made in this task.

An early HTTP-gated test encountered the daemon's intentional localhost access
policy. The final control tests use local FQL execution and require no network
policy change. This was a fixture mismatch, not a debugger product failure.

## Commands and artifacts

Before adding debugger production code, the alpha.7 upgrade gate passed the
existing JetBrains suite (124 unit/platform tests and 12 real-daemon tests) and
VS Code suite (138 unit tests and 13 integration tests). All six release targets
were acquired through `make prepare jetbrains` with existing checksum checks.

The completed validation commands are:

```text
make build jetbrains
make lint jetbrains
make test jetbrains
make package jetbrains
make package-check jetbrains
make proto-generate jetbrains
make proto-check jetbrains
make proto-generate vscode
make proto-check vscode
make test vscode
make lint vscode
make package vscode
make package-check vscode
git diff --check
```

JetBrains has 152 unit/platform tests and 20 real-daemon tests. Real tests run
through the existing integration category with the acquired native alpha.7
binary supplied by `FERRETD_TEST_PATH`. Regeneration produced no client changes
for either editor; both drift checks pass. The final full-diff review covered
all tracked and newly added source/test/documentation files, ownership,
cancellation, protocol ordering, UI dispatch, exclusions, and packaging.

After the successful full build/lint/test/package/check sequence, two final
controlled-adapter tests were added for pending configurationDone cancellation
and initialize rejection. Repeating `make test jetbrains` then hit Buf's remote
generation quota (`resource_exhausted: too many requests`) before reaching
Gradle. The unchanged schemas and generated files already had passing drift
checks. The final unit/platform suite was rerun with
`extensions/jetbrains/gradlew -p extensions/jetbrains --offline test`; the real
suite and production artifact were unaffected by these test-only additions.

The universal archive is
`build/distributions/ferret-jetbrains-0.1.0.zip`. Package validation compares all
six embedded daemon binaries against their verified alpha.7 release bytes,
checks the version marker and Unix executable modes, and executes the native
binary's version smoke check. Targets: darwin arm64/x64, linux arm64/x64, and
win32 arm64/x64. Cross-target binaries were verified, not executed on this Mac.
The native VSIX is `../vscode/dist/ferret-vscode-0.1.0-darwin-arm64.vsix` and passed
its independent package check. Generated binaries and build outputs remain
ignored and are not source changes.

## Manual sandbox limitations

The repository's runIde task launched the built plugin in an isolated sandbox
with disposable FQL fixtures. The UI tool listed **IntelliJ IDEA Sandbox** as
`com.jetbrains.jbr.java`, but attempting to target either that ID or that name
returned **Invalid app**. The owned sandbox was then shut down. Its exit 143
records that deliberate shutdown, not a plugin crash.

All requested manual gestures remain **BLOCKED by the UI-control environment**:
Debug current file, initial/live breakpoints, Pause/Continue, all three stepping
actions, stack navigation, Stop, normal completion, external runtime directory,
Unicode source, simultaneous Debug sessions, Run plus Debug, and project close.
M1/M2 visual language and Run regressions also remain unverified manually.
Automated evidence above covers protocol and native-platform contracts, but
does not substitute for visual sign-off, IDE restart/reopen persistence, every
gutter move gesture, or testing Linux/Windows hosts.

Documentation updated with this implementation: the JetBrains README, root
capability summary, AGENTS.md, and a current-status note above the unchanged
historical architecture spike. Source-snapshot behavior and T3 exclusions are
documented in the JetBrains README.
