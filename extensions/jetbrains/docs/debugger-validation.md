# JetBrains debugger validation

## September 22, 2026: alpha.9 explicit-file admission

The sole repository pin is now `1.0.0-alpha.9`. The
[upstream release](https://github.com/MontFerret/ferretd/releases/tag/v1.0.0-alpha.9)
includes explicit source admission and the macOS and Windows test-fixture
corrections from PR #28. The alpha.8-to-alpha.9 release diff
contains no protobuf changes. Both supported generators ran against the new
schemas and produced no client diff.

Run and Debug now accept explicitly selected lowercase `.fql` regular files
beneath discovery-excluded directories and nested Go modules. Source identity,
the compilation workspace, containment, nested-symlink restrictions, and
immutable active-session snapshots retain their existing contracts. Editorium
adds no admission logic, path rewriting, source copies, or workspace fallback.

### Regression evidence

The native Run test, both native Debug tests, and both native inspection tests
now retain `.tmp` fixtures permanently. They cover saving edited documents,
source navigation, live breakpoint controls, caller-frame selection, recursive
values, expression evaluation across stops, concurrent sessions, project lifetime
cancellation, and relaunch. The selected-frame fixture uses `.tmp/test.fql`;
ordinary-directory cases remain in the existing real-daemon suites.

Two additional real-daemon tests each exercise `.tmp/test.fql`,
`testdata/test.fql`, and `module/test.fql` beneath a nested `go.mod`.
Run checks the returned Session workspace ID, relative path, original canonical
source URI, results, saved edits, and daemon reuse. DAP checks a verified
breakpoint, original stack source, locals, evaluation, final output, and adapter
termination. Both read a root-owned file with no runtime-directory override;
different contents in each source parent detect an accidental workspace fallback.

The seven focused alpha.9 tests passed. Against retained alpha.8, both new
tests failed on `.tmp/test.fql`: DAP returned `workspace document not found`,
and Run reported `Ferret source was not found.` The complete subsequent
alpha.9 suite passed. The first focused attempt also corrected a test expectation
to use JetBrains' canonical macOS path rather than its temporary-directory alias;
no production path conversion changed.

### Automated validation

Local environment: macOS arm64, Go 1.26.5, Temurin JDK 25.0.4.1 for Gradle,
Node.js 26.5.1, and IntelliJ Platform 2026.2.0.1 (`IU-262.8665.337`).
These results do not claim execution on the CI Node.js 22 environment or on
Linux/Windows hosts.

| Check | Result |
| --- | --- |
| `make prepare jetbrains` | PASS; all six alpha.9 release archives checksum-verified and staged. |
| `make proto-sync FORCE=1`; both `proto-generate` and `proto-check` targets | PASS; generated Java and TypeScript clients unchanged. |
| `go test ./...` in `tools/editorium` | PASS. |
| `make test jetbrains` | PASS; 173 unit/platform tests and 29 real-daemon integration tests, zero failures, errors, or skips. |
| `make lint jetbrains` | PASS; Plugin Verifier reports compatibility with IU-262.8665.337. |
| `make build jetbrains` | PASS; universal build and structure validation. |
| `make package jetbrains`; `make package-check jetbrains` | PASS; complete six-target matrix, alpha.9 version marker, binary bytes, Unix modes, and native executable version checked. |
| `make test vscode` | PASS; 138 unit tests, 13 integration tests, and daemon execution transport smoke. |
| `make lint vscode`; `make build vscode` | PASS. |
| `make package vscode`; `make package-check vscode` | PASS; native darwin-arm64 VSIX. |
| Final diff review | PASS; ownership, cleanup, source identity, coverage, generated output, documentation, and whitespace reviewed. |

The universal artifact is
`extensions/jetbrains/build/distributions/ferret-jetbrains-0.1.0.zip`.
The native VSIX is
`extensions/vscode/dist/ferret-vscode-0.1.0-darwin-arm64.vsix`.
Other-host daemon binaries were validated as package contents, not executed.
No plugin version was changed, no extension release was published, and the
user's installed plugins were not replaced. Installed alpha.8 bundles remain
affected until updated to a build containing the correction.

### Manual IDE attempt

An isolated target-version IDE was launched with disposable system/config/plugin
directories and a project containing `.tmp/test.fql`, an inspection configuration,
and an ordinary `normal.fql` control. Its log confirms
`IU-262.8665.337` and `Loaded custom plugins: Ferret (0.1.0)`; the sandbox's
daemon version marker is `1.0.0-alpha.9`.

Computer control listed **IntelliJ IDEA Alpha9 Sandbox**, but selecting either
`com.jetbrains.jbr.java` or the displayed name returned **Invalid app**.
The owned launch was interrupted and exited with code 130. Manual Run, Debug,
breakpoints, caller selection, expansion, watches, controls, termination, and
relaunch remain **UNVERIFIED**. Automated native-platform results above do not
substitute for that UI matrix.

The alpha.8 reports below preserve their original versions, test counts, and
manual limitations; their pin statements describe those historical runs.

## September 22, 2026: M3 T3 inspection and hardening

M3 T3 implements lazy native scopes and recursive typed values, selected-frame
expression evaluation, and native watches through each frame's evaluator. The
Debug console remains output-only. Validation uses the unchanged root
`ferretd 1.0.0-alpha.8` pin on macOS arm64, Temurin JDK 25.0.4.1, LSP4J 0.24.0,
and IntelliJ Platform 2026.2.0.1 (`IU-262.8665.337`). Production changes are confined
to the JetBrains debugger; protocols, Run ownership, settings, and public commands
are unchanged.

### Automated inspection evidence

| Contract | Result and evidence |
| --- | --- |
| Lazy scopes and values | Platform tests request scopes only from frame `computeChildren`, initially collapse Locals/Parameters, and request children only on expansion. Nested values preserve upstream names, types, empty/null-like text, opaque summaries, and positive references. Nonpositive references send no variables request. |
| Caller-frame support | Real alpha.8 tests stop inside `inner`, with distinct `inner`, `outer`, and `<main>` bindings. They inspect and evaluate all three frames, page to the caller, and expand collections owned by the main frame. Native XDebugger tests select the caller and main frame and use their actual evaluators. |
| Expressions and watches | The shared frame evaluator preserves the selected ID and expression text, leaves DAP context unset, and returns the same expandable value model. Native tests reevaluate after step-out and the next breakpoint. Tests exercise the Ferret evaluator contract; JetBrains owns watch storage and refresh UI. |
| Expression-only editing | Public evaluator overrides disable code fragments and select expression mode even for multiline selections. Explicit code-fragment evaluation is rejected without DAP traffic; callbacks complete on the EDT even when called from a background thread. The existing ordinary-document Ferret editor provider is reused. |
| Safe evaluator surface | Real tests cover bindings, typed parameters, member/index access, scalar operators, empty input, invalid syntax, unknown names, rejected calls, invalid frame IDs, and invalid child references. Rejection leaves subsequent inspection usable. |
| Runtime failure | Division by zero stops with an inspectable frame and local `x = 7`; evaluation succeeds before continuation produces exit code 1. |
| Stop lifetime | Controlled requests remain manually pending across Continue, Next, Step In, Step Out, replacement stops, rejected controls, Stop, termination, transport loss, and owning-scope cancellation. Old callbacks settle, timers are cancelled, and late successes/errors cannot revive old handles. Rejected controls publish a fresh local generation. |
| EDT presentation races | Explicit barriers hold the EDT after a protocol result arrives, replace the stop, and then release presentation. Obsolete live nodes finish empty; evaluators finish once with an unavailable-context error. Obsolete/disposed nodes receive no values or error banner. No sleeps coordinate these races. |
| Local deadlines | Controlled tests assert all four deadline jobs are cancelled on invalidation, then await a later request batch's deadlines without sleeps. Inspection timeouts leave the session usable. Control-command timeouts retain fatal handling because execution state is unknown. |
| Session/project isolation | Real and native tests run concurrent Debug sessions, terminate one, inspect the other, and launch a fresh session. Platform tests dispose a separate project with pending inspection while a peer project remains usable. Real Run + Debug tests inspect throughout independent Run cancellation. |
| Breakpoints and controls | The complete existing breakpoint/control suite runs together with inspection coverage. Real stepping, live replacement, pause, native enable/disable/mute, startup synchronization, committed stops, and cleanup regressions remain covered. |
| Logging | Adapter stderr is drained; owned diagnostics retain category/class/code without exception messages, values, or payloads. Program output is preserved in the Debug console. Unsolicited responses are rejected before LSP4J's payload-bearing warning path. |

Primary tests:
[controlled inspection](../src/test/kotlin/org/ferretlang/jetbrains/debugger/FerretDapInspectionTest.kt),
[presentation](../src/test/kotlin/org/ferretlang/jetbrains/debugger/FerretInspectionPlatformTest.kt),
[real inspection](../src/test/kotlin/org/ferretlang/jetbrains/integration/FerretDapInspectionIntegrationTest.kt),
and [native selection/lifecycle](../src/test/kotlin/org/ferretlang/jetbrains/integration/FerretNativeInspectionIntegrationTest.kt).

### Corrections and backend limits

The typed-parameter fixture exposed a local T2 transport defect: converting launch
bindings to a generic map let LSP4J's Gson configuration omit null object members.
A wire-level regression first reproduced the missing binding. A parameter-only
serializer now preserves top-level and nested nulls without serializing omitted
optional fields elsewhere in DAP. All typed launch parameters are referenced in
the real fixture, so they are exposed according to the compiled program's backend
contract. The plugin does not invent entries for unused parameters.

The current daemon intentionally returns `Array(9)` with type `Array` and
`variablesReference: 0` for the nine-item fixture. Real tests assert that summary
and zero reference; controlled tests assert no expansion request. There is no
client paging or synthetic expansion. Direct canonical bindings retain upstream
`evaluateName`, and evaluation results retain the entered expression. Nested
children omit evaluation expressions because alpha.8 can return bare names such
as `nested`, which are not valid standalone expressions in the selected frame.
Users can enter qualified member/index expressions themselves. These are backend
limitations, not new upstream defects found during this implementation.

Review also tightened stale-response handling, released queued runtime values
and transport references during cleanup, restored user-expanded scopes at a new
stop, and moved explicit code-fragment rejection and top-frame error publication
behind EDT lifetime checks. Diagnostic regressions cover unsolicited error
responses and safe errors for unsupported adapter requests. Inspection state
remains owned by the existing per-session queue; there is no independent value
cache, parser, REPL, watch service, renderer framework, or DAP cancel request.

### Commands and manual status

| Check | Status | Evidence |
| --- | --- | --- |
| Focused tests | PASS | Controlled, presentation, real-daemon, and native inspection tests ran before broad validation. |
| `make test jetbrains` | PASS | Protocol drift validation, 173 unit/platform tests, and 27 pinned-daemon integration tests; zero failures, errors, or skips. |
| `make lint jetbrains` | PASS | Plugin Verifier reports compatibility with IU-262.8665.337. |
| `make build jetbrains` | PASS | Universal plugin build and structure validation. |
| `make package jetbrains` | PASS | Universal ZIP built and verified through repository tooling. |
| `make package-check jetbrains` | PASS | All six pinned daemon artifacts, version marker, executable modes, and native version validated. |
| Complete diff/self-review | PASS | Tracked and new files reviewed for ownership, lifecycle, public API use, threading, diagnostics, coverage, and documentation. Affected checks rerun; whitespace and local documentation links pass. |
| Manual target-version IDE matrix | BLOCKED / UNVERIFIED | The target IDE loaded Ferret, but computer control rejected its Java-hosted sandbox application. Details below. |
| Other hosts / hosted CI | NOT RUN | These local results do not claim Linux, Windows, or hosted CI execution. |

The final archive is `extensions/jetbrains/build/distributions/ferret-jetbrains-0.1.0.zip`.
Package validation compared all six embedded daemon binaries with the verified
alpha.8 release bytes. Cross-target binaries were verified, not executed on this
Mac. Generated clients and the root daemon pin have no diff.

The manual attempt used `runIde` with disposable FQL projects and an ignored
task-local Gradle init script. Default sandbox startup failed in IntelliJ's
`DirectoryLock` with `SocketException: No such file or directory`; shortened
system/config paths and an explicit writable Java temporary directory allowed
startup. The IDE log confirms build `IU-262.8665.337` and `Loaded custom plugins:
Ferret (0.1.0)`. Computer control listed **IntelliJ IDEA M3 T3 Sandbox** with bundle
ID `com.jetbrains.jbr.java`, but selecting either the ID or the displayed name
returned **Invalid app**. The owned launch was then interrupted and shut down;
exit 130 records that deliberate cleanup.

No manual pass is claimed for watches and their persistence/refresh, caller-frame
selection, nested expansion, live gutter breakpoint edits, Pause/Continue or any
step gesture, termination/relaunch, Run + Debug, normal Run, or project close.
The native automated tests above verify those integration contracts where stated;
they do not replace the requested visual smoke matrix. No new Ferret/ferretd
defect was found that requires an upstream exchange or client workaround.

The historical T2 reports below preserve their original versions, counts,
limitations, and validation outcomes; they are not the current T3 capability
or test summary.

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
