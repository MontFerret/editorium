# Ferret for JetBrains IDEs

This module is the JetBrains IDE integration for Ferret Query Language files.
It registers `.fql` files, provides language intelligence through JetBrains'
native LSP support, and runs and debugs queries through native Ferret configurations.
The plugin bundles the required `ferretd` executable.

The
[M3 T1 debugger architecture report](docs/debugger-architecture.md) records the
selected DAP/XDebugger design and historical spike evidence. M3 T2 implements
debugger control and stacks; M3 T3 adds suspended-frame inspection, expression
evaluation, native watches, and inspection lifecycle hardening.

## Prerequisites

- Go 1.26 or newer for the shared Editorium distribution tool;
- a JDK 21 or newer to run Gradle;
- network access on the first build for Gradle, JetBrains dependencies, and the
  pinned `ferretd` release; and
- enough disk space for the IntelliJ Platform development distribution and six
  native daemon artifacts.

IntelliJ Platform 2026.2 and 2026.3 compile and run on Java 25. The Gradle build
uses the Foojay resolver to provision that toolchain automatically when it is not
installed locally. Ferret plugin bytecode also targets Java 25.

Use the checked-in Gradle wrapper; a system Gradle installation is not needed.

## IDE compatibility

The supported products are IntelliJ IDEA and GoLand on the 2026.2 and 2026.3
release lines. The plugin compiles against IDEA `2026.2.0.1`, targets Java 25,
and retains `sinceBuild = "262"`. Its descriptor has no upper build bound;
this does not establish compatibility with untested future releases or other
JetBrains products.

Plugin Verifier uses these explicit, stable distributions:

| Product | Version | Build |
| --- | --- | --- |
| IntelliJ IDEA | `2026.2.0.1` | `IU-262.8665.337` |
| IntelliJ IDEA | `2026.3` | `IU-263.7307.200` |
| GoLand | `2026.2.4` | `GO-262.11879.101` |
| GoLand | `2026.3` | `GO-263.7307.211` |

These versions are independently listed in
[JetBrains release metadata](https://data.services.jetbrains.com/products/releases?code=II%2CGO&latest=false&type=release).
Both release lines require Java 25 according to the
[JetBrains platform version table](https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html#platform-versions).
The existing `intellij.platform.debugger` build dependency covers the debugger
module extraction described in the
[2026.3 API changes](https://plugins.jetbrains.com/docs/intellij/api-changes-list-2026.html).

Verification rejects incompatible, deprecated, internal, override-only, and
scheduled-for-removal API usage. It checks binary compatibility; installed IDE
workflows require a separate interactive smoke test. See the
[validation report](docs/debugger-validation.md) for actual results.

## Daemon distribution

The repository-root `ferretd.json` is the sole daemon version pin for both
Editorium integrations. JetBrains preparation calls the shared Go tooling under
`tools/editorium`, which constructs versioned release URLs, verifies the
official checksum manifest, safely extracts the executable, and caches verified
artifacts under `.dist/ferretd/<version>/<target>/`.

The JetBrains plugin is one universal archive containing:

```text
ferretd/version
ferretd/darwin/arm64/ferretd
ferretd/darwin/x64/ferretd
ferretd/linux/arm64/ferretd
ferretd/linux/x64/ferretd
ferretd/win32/arm64/ferretd.exe
ferretd/win32/x64/ferretd.exe
```

Generated binaries are staged under `build/generated/ferretd/`, are copied next
to the installed plugin's `lib/` directory, and are ignored by Git. Gradle marks
the macOS and Linux entries executable. Repeated builds reuse unchanged Gradle
outputs and re-verify cached release archives whenever preparation runs.

At runtime, a stateless resolver maps the JVM OS and architecture to this layout,
validates the installed executable and version marker, and returns that passive
description. It never searches `PATH` or owns a process. The Ferret LSP
descriptor constructs the `ferretd lsp` command line, and the JetBrains LSP
subsystem owns that process and protocol lifecycle. Run configurations use a
separate project service; the LSP process is never reused for execution.

## Project runtimes

Open **Settings → Languages & Frameworks → Ferret** to choose a **Runtime
configuration file**. The project saves the entered path. Relative paths use
the project base directory. A project without a base directory requires an
absolute path. An empty setting uses the daemon's built-in configuration.

This development file defines an application on loopback.

```json
{
  "defaultRuntime": "local",
  "runtimes": [
    {
      "name": "application",
      "label": "Embedded application",
      "provider": "wire",
      "endpoint": "tcp://127.0.0.1:9000",
      "insecure": true,
      "connectTimeout": "5s"
    }
  ]
}
```

The daemon defines `local` implicitly. Leave it out of the runtimes array.
This loopback example explicitly opts into a plaintext Wire connection through
`insecure: true`.

Expand **Runtime catalog** or open the **Runtime** picker in a Ferret Run/Debug
configuration to load the applied settings. Each entry shows the exact name,
label and provider. Discovery also identifies the configured default. These are
configuration metadata. An offline application can appear in the catalog.

**Apply** saves the path. Before any launch or discovery has adopted a
configuration, first use loads the latest saved path. Once a launch or discovery
has used a configuration, changing or clearing its path requires **Reload runtimes**,
even after the session ends or daemon startup fails. Edits to the file at the same path also
require **Reload runtimes**. Reload starts a fresh project execution daemon
and reads its catalog. Finish or stop active Run and Debug sessions and wait
for cleanup before reloading. Pending changes block new launches. If the
replacement started but its catalog request failed, **Retry discovery** reads
that same daemon. If the replacement exits, use **Reload runtimes** to start another.
If replacement startup fails, correct the error and reload.

The Run/Debug **Runtime** picker saves **Daemon default** as an empty selection,
or saves an exact, case-sensitive runtime name, including explicit `local`.
A saved name stays selected if the catalog changes or the application definition
disappears. Run and Debug can use the configured default, a named Wire application, or
explicit `local` even when the default is Wire. If a saved runtime is missing,
correct the definition and reload, or choose another runtime.

### Run and debug an embedded application

1. From the repository's `fixtures/wire-host` directory, run
   `GOWORK=off go run -mod=readonly . -root .` in a terminal with Go 1.26.1
   or newer. In PowerShell, set `$env:GOWORK = 'off'` before running
   `go run -mod=readonly . -root .`. Keep stdin open. Copy the endpoint
   from the JSON `ready` event.
2. Save the runtime configuration above in a local JSON file. Replace the
   endpoint with the printed address, set `defaultRuntime` to `"application"`,
   and keep `insecure` enabled for this loopback fixture. Apply the file in
   **Settings → Languages & Frameworks → Ferret**, then open **Runtime catalog**
   and confirm that `application` is the default Wire runtime.
3. In a local project, save this query as `hosted.fql`. Create a Ferret Run
   configuration for it with parameters `{"value":41.5}`, a blank working
   directory, and **Daemon default**. Run it and check the console for `42.5`.

   ```fql
   LET answer = DEMO::IDENTITY(@value)
   LET result = answer + 1
   RETURN result
   ```

4. Set a breakpoint on line 2 and Debug the same configuration. Inspect
   `answer` in Locals, evaluate or watch `answer + 1`, step over to line 3,
   and continue to the console result. Debugging follows the local FQL source.
5. Debug again, stop at the breakpoint, and click **Stop**. The host prints
   `released` with the same ID as the launch's `connected` event. Run again
   against the same terminal and endpoint. The application owns the embedded
   engine. Each IDE launch starts a new FQL query and owns its session and
   connection. Stop releases those resources. Existing application queries
   continue independently.
6. To switch endpoints, start another host, edit the JSON, and choose **Reload
   runtimes** after active launches finish. If you select a different config
   file, **Apply** saves the path and **Reload runtimes** adopts it. Close stdin
   in the fixture terminal for graceful shutdown and an `engineClosed` event.

## Language intelligence

Ferret language intelligence is implemented by `ferretd` and exposed to the
plugin over standard LSP input and output. The plugin identifies local `.fql`
files, resolves the bundled daemon for the current host, and gives JetBrains the
command line. It does not implement a separate parser, completion engine,
formatter, or other Ferret semantics.

The daemon starts lazily when an applicable file is opened. Starting the IDE or
opening a project without a local `.fql` file does not start it. A project uses
one project-wide LSP client for its Ferret files, and JetBrains stops the process
with the project. The pinned daemon advertises diagnostics, completion, hover,
same-document definition navigation, and full-document formatting to the
standard JetBrains language actions.

Definition lookup is currently document-local. `ferretd` 1.0.0-alpha.7 does not
advertise project or module resolution, so a symbol declared in another `.fql`
file is not a supported navigation target.

## Run configurations

Open a local `.fql` file and use its native **Run** context action or the
toolbar's **Current File** selection. JetBrains creates or reuses a Ferret Run
configuration for that source. Generated names use the project-relative path,
such as `queries/users.fql`, so files with the same filename remain recognizable.
Switching files selects the corresponding current-file configuration; a saved
configuration in the selector continues to run its configured source.

To create a configuration manually, open **Run | Edit Configurations**, select
**Add New Configuration**, and choose **Ferret**. Each configuration contains:

- **Runtime** follows the daemon default or saves an exact catalog name.
- **Source file**: the `.fql` file to execute. The chooser filters for Ferret
  files, while a path entered by hand may be absolute or relative to the
  project base directory.
- **Working directory**: the root used by Ferret runtime filesystem operations.
  New configurations leave it blank to use the selected runtime’s default.
  Native uses the compilation workspace by default. Wire uses the remote
  application’s own filesystem default. Changing the runtime preserves this field.
- **Parameters (JSON object)**: named FQL bind parameter values. Keys omit the
  `@` prefix: `"limit": 10` binds `@limit` in the query. For example:

  ```json
  {
    "baseUrl": "https://example.com",
    "limit": 10,
    "options": {
      "enabled": true
    }
  }
  ```

  An empty field is treated as `{}`. The top level must be an object; nested
  arrays and scalar values are supported. Malformed JSON and non-finite numbers
  are rejected. Configurations produced from the current file start with empty
  parameters, including when the Run configuration template contains values.

The source file is required; the working directory is optional. At every Run,
the plugin snapshots the configuration and resolves the local source and
compilation workspace to their canonical locations. The compilation workspace
is the project base directory when one exists, otherwise the canonical source
parent. A present project base
must be a readable directory containing the source; the plugin does not fall
back when it is invalid. Relative local paths require a project base.

The bundled daemon accepts explicitly selected lowercase `.fql` regular files
inside discovery-excluded directories such as `.tmp`, `testdata`, and nested Go
modules. For example, a configuration targeting `.tmp/test.fql` runs and debugs
that file within the project workspace, preserving its source identity. Automatic
discovery exclusions remain in effect for neighboring files; workspace containment
and the daemon's nested-symlink restrictions are unchanged. Plugins bundled with
`ferretd 1.0.0-alpha.8` require updating to a build containing alpha.9 or later
to use this capability.

For native execution, an explicit working directory must resolve to a readable
local directory. It can be project-relative or absolute and may lie outside the
workspace. Wire forwards a nonblank override exactly as entered, including
relative paths, runtime-host path syntax, and surrounding spaces. The embedded
application interprets that value. In both cases the source and compilation
workspace stay on the plugin host. A remote working directory does not transfer
workspace files or change the source’s workspace-relative identity.

Run configurations survive IDE restart, project reopen, and duplication.
Runtime names and working-directory overrides preserve literal text, including
`$PROJECT_DIR$`. In shared Run configuration XML, simple names and relative
directories stay readable. Other values use a marked Base64URL encoding.
Older configurations retain the IDE's usual path-macro interpretation on load.
Source paths continue to use JetBrains path macros. IDE rename/move
refactorings of the source or its parent directories update the stored source
path and generated name, including undo. Custom names, working directories,
parameters, and relative versus absolute path choices are preserved. External
filesystem moves cannot repair an old stored path; select the new source or
use Run Current File. Other file types do not offer a Ferret configuration.

JetBrains saves documents before Run and flushes pending filesystem updates.
Ferret executes the saved source through a fresh compilation session on each
invocation, so saved edits, renamed sources, and newly created files take effect
without restarting the IDE. If the source document remains unsaved, execution
fails with a request to save it rather than using older disk contents. A source
saved during an active run takes effect on the next invocation.

Running a configuration immediately opens the normal JetBrains Run console.
The console identifies the effective runtime and provider before session acquisition.
The daemon acquires the binding and compiles the saved source on that runtime.
Filesystem and daemon work continues off the UI thread. Parameter nulls,
booleans, finite numbers, strings, arrays, and objects retain their types. The
console shows formatted JSON results, including a literal `null`. A run with
absent or zero-byte output completes without a result line. A blank content
type displays the returned UTF-8 text. Failed runs show their diagnostics and
label any retained nonempty content **Partial output**. Results arrive when the query
finishes. The IDE log records process and transport details. Runtime configuration failures
also appear in the catalog view.

The first Run or runtime discovery request lazily starts a dedicated execution
daemon for that project.
The plugin verifies the exact bundled binary version and requires API major 1
with minor 1 or later. A configured catalog or any explicit runtime name requires
API 1.3 or newer within major 1. Run uses the catalog from the daemon it borrowed
and checks the returned session name before starting a query. Applying a new
configuration during preparation takes effect for new launches after Reload.
Opening a Ferret file may start language support but does not start execution
infrastructure. Subsequent runs reuse the execution daemon; concurrent runs
have independent parameters, results, working directories, and cancellation.
Different projects own separate execution daemons.

**Stop**, detach, and Run-tab closure cancel only that invocation. Successful
runs exit 0, failures exit 1, and a locally requested cancellation exits 130.
Session acquisition has a 30-second deadline covering runtime connection and
compilation. If you press Stop during acquisition, the console enters its
cancelling state immediately. It waits for the bounded reply and closes any
returned session before releasing the Run and allowing Reload. Short control
RPCs have five-second deadlines. Running queries have no overall time limit.

Stopping a Wire Run releases its owned query, session and binding. The external
application and Wire server stay running. A lost binding fails that Run. A later
explicit Run can acquire a new binding. A project daemon crash fails current
runs and invalidates its workspaces and catalog. Closing the project cancels
its Runs and shuts down the project daemon.

## Debugging

Use **Debug** on the same Ferret configuration or current local `.fql` file.
JetBrains saves the source and uses the same local compilation workspace, typed
parameters, and provider-specific working directory as Run. Every Debug launch
starts an independent bundled `ferretd dap`. With an empty runtime selector and
configuration path, it uses the built-in `local` directly. Otherwise it resolves
the default or exact selector against the admitted project catalog. A configured
adapter receives `--runtime-config` and the same absolute path as the project
daemon. Both resolve `.` and `..` in the path before opening the file.

Debug checks the configuration file against the content fingerprint recorded
when the project daemon started. If the adapter exits before it can initialize,
Debug rechecks the file before reporting the failure. An edit or loss of
readability detected during startup requires **Reload runtimes** after active
sessions finish cleanup. These checks detect ordinary edits across
the two processes’ independent reads. Apply during startup leaves that launch
bound to its original path.

A configured file or explicit selector requires the adapter to advertise
`supportsFerretRuntimeSelection`. Discovery and initialization can succeed
while a Wire application is offline. Acquisition happens at launch. A supporting
adapter must acknowledge the expected runtime after breakpoint configuration.
A missing or incorrect acknowledgment ends the session. The query may already
have started when the adapter replies. An older compatible adapter can still
debug the unconfigured default.

Set ordinary line breakpoints in the gutter before or during a session. They
persist with the project. Enabled, disabled, moved, removed, and muted
breakpoints are synchronized immediately as complete per-source replacements.
The daemon decides whether a line is executable and may bind to a later line;
the original breakpoint stays in place, with verification details in its
presentation. An unverified breakpoint does not fail launch. A synchronization
request failure fails that Debug session and cleans up its adapter.

The bundled `ferretd` alpha.8 fixes the alpha.7 first-statement breakpoint
limitation. A verified breakpoint on the first executable statement stops
normally with `stopOnEntry=false`.

The standard Debug window supports **Resume**, **Pause**, **Step Over**,
**Step Into**, **Step Out**, and **Stop**. One logical **Ferret** stack shows frame
names and source locations, including Unicode columns. A confirmed stop remains
suspended even if its breakpoint is subsequently removed. Missing or nonlocal
source information is shown without an invented navigation location.

Select a stack frame to inspect its **Locals** and **Parameters** groups.
Scopes and child values load on expansion. Types and display text come directly
from `ferretd`; a value expands only when the daemon provides a child reference.
Caller frames retain their own locals and evaluator context. **Parameters** shows
the launch bindings exposed by the compiled program's debugger, including typed
nulls, arrays, and objects; unused configured parameters may be absent.

Use **Evaluate Expression** and ordinary **Watches** against the selected frame
while suspended. Ferret's safe evaluator supports binding and parameter
references, member/index access, and scalar operators. Calls, mutation, and full
program/code-fragment evaluation are unavailable. Expressions are sent unchanged
to the daemon. Inspection refreshes at each stop; obsolete results cannot replace
the current values. An expression or node-level request error does not end an
otherwise usable session. Runtime-failure stops remain inspectable until resumed
or terminated.

Current upstream limitations:

- Collections exceeding the inspection limit (currently eight items) can appear
  as summaries such as `Array(9)` without expansion. The plugin does not fabricate
  children or provide variable paging.
- Nested values currently supply bare names rather than qualified evaluation
  expressions. Their automatic add-to-watch expression is unavailable. Enter a
  valid member/index expression manually in Watches or Evaluate Expression.

Debug compiles a snapshot of the saved source at launch. Editing or saving the
source while paused does not recompile that session; changed line numbers may
no longer match the snapshot. Start a new Debug session to execute those edits.
Live breakpoint edits apply to the existing compiled snapshot.

The Debug console retains daemon stdout/stderr output and final results.
Adapter stderr is drained without copying runtime content to IDE logs. Diagnostic
logs record operation/error categories, excluding expressions, values, parameter
contents, and protocol payloads. Console input is unavailable. Stop, detach, and
project disposal release the query binding and its owned adapter. The external
application and Wire server keep running. Stop during catalog preparation
detaches this launch from shared project discovery. Reload stays unavailable
until cleanup finishes. Loss of the project execution daemon leaves an already
running Debug session usable. Target exit codes are retained, with 1 for
failures and 130 for local cancellation when the target has not supplied a code. Startup and protocol requests have
bounded deadlines; running queries have no execution time limit.

Conditional breakpoints, logpoints, interactive console input,
attach, restart, and reverse debugging are also unavailable. The breakpoint UI
hides unsupported condition, action, dependency, and suspend-policy controls.

See the [debugger validation report](docs/debugger-validation.md) for automated
coverage, manual results, and remaining validation limits.

## Build and test

The root Make interface is the normal contributor workflow:

```sh
make prepare jetbrains
make build jetbrains
make lint jetbrains
make test jetbrains
make package jetbrains
make package-check jetbrains
make proto-generate jetbrains
make proto-check jetbrains
```

`prepare` downloads only missing pinned artifacts and atomically refreshes the
generated daemon tree. `build` and `package` also ensure preparation has run
through the Gradle sandbox dependency. The distributable archive is written to:

```text
extensions/jetbrains/build/distributions/ferret-jetbrains-0.1.0.zip
```

The equivalent module-local Gradle commands are:

```sh
cd extensions/jetbrains
./gradlew test
./gradlew buildPlugin verifyPluginProjectConfiguration verifyPluginStructure
./gradlew verifyPlugin
```

Ordinary `./gradlew test` remains offline and excludes real-daemon tests. Root
`make test jetbrains` checks generated-client drift, acquires only the pinned
current-host daemon, runs unit tests, and then runs `ferretdIntegrationTest` with
`FERRETD_TEST_PATH`. Running that Gradle task directly without an executable
`FERRETD_TEST_PATH` is an error, not a skip.

The integration task builds the standalone Go module in `fixtures/wire-host`
with its workspace disabled. It checks the linked Core, API, and Wire versions
against the acquired daemon and starts an independently owned application for
each hosted test. The integration suite runs on every invocation. Its host
executable is under `build/test-fixtures/`, outside the plugin sandbox and ZIP.

`make lint jetbrains` and `make package jetbrains` both invoke `verifyPlugin`
against all four distributions in the compatibility matrix. Reports are written
under `build/reports/pluginVerifier/`; the JetBrains CI packaging job uploads
them even after a failed check. The root package check verifies the complete
set of JARs and hashes each external dependency against Gradle's resolved
production libraries. It checks daemons against the verified release cache,
checks the version and Unix executable modes, and runs the native daemon's
`--version` smoke check.

## Release the plugin

`make release jetbrains <version>` reads `pluginVersion` from `gradle.properties`
and creates the annotated `jetbrains/v<version>` tag after strict qualification.
The tagged workflow publishes one signed universal ZIP and its SHA-256. See the
[maintainer release guide](RELEASING.md) for environment setup, first listing,
stable updates, and recovery. The current daemon's suspended Wire host-loss
failure and pending packaged smoke are recorded in the
[validation report](docs/debugger-validation.md).

## Smoke-test the packaged plugin

Use GoLand `2026.3` (`GO-263.7307.211`) with disposable configuration, system,
plugin, and project directories. Use the checksum-verified signed GitHub ZIP for
a release smoke, or the output of `make package jetbrains` for development. Install
the selected ZIP through **Settings | Plugins | Install Plugin from Disk**,
and restart that isolated IDE. Confirm the loaded Ferret plugin and all launched
daemon paths belong to that installation, with the version from `ferretd.json`.

1. Open a local `.fql` file and confirm Ferret recognition and lazy LSP startup.
   Check diagnostics for invalid source, completion, and **Reformat Code**.
2. Create a native Ferret configuration for the query below, save/reopen its
   configuration, and Run it. Confirm the Run console result is `[2, 4, 6]`.
3. Set a line breakpoint on the final `RETURN` (line 3), Debug, step, inspect a
   local binding, and evaluate `value + 1` or add it as a watch while suspended.
4. Stop, then successfully Run or Debug again.
5. Close the project and confirm its LSP, execution-daemon, and DAP processes
   terminate. Other projects' processes must remain independent.

```fql
RETURN FOR value IN 1..3
    LET doubled = value * 2
    RETURN doubled
```

For embedded-runtime release smoke, repeat the walkthrough in the isolated
installation. Record the ZIP filename and SHA-256, bundled daemon version,
exact IDE build, and observed result for each step. See
[Run and debug an embedded application](#run-and-debug-an-embedded-application).

A successful
build, Plugin Verifier run, or IDE launch alone does not complete this smoke
test. Its actual status and any remaining manual steps are recorded in the
[validation report](docs/debugger-validation.md).

## Launch a development IDE

Run the standard IntelliJ Platform development task:

```sh
cd extensions/jetbrains
./gradlew runIde
```

In the sandbox IDE, create or open `test.fql` and confirm the Ferret file type
and icon. Opening the file should lazily start the bundled `ferretd lsp` and
enable the language features advertised by the daemon. Useful manual checks
include:

- enter invalid Ferret source and confirm diagnostics appear;
- type `re` and invoke completion, then confirm `return` is offered;
- hover over `abs` in `RETURN abs(-1)`;
- navigate from a variable use to its declaration; and
- run **Code | Reformat Code** on `LET value=1` and confirm the LSP formatter
  applies the edits returned by `ferretd`.

Open **Run | Edit Configurations** and confirm **Ferret** is available. Create a
configuration, select `test.fql`, choose a working directory, enter a JSON
parameter object, apply the changes, and reopen the dialog to confirm they were
preserved. From the open `test.fql` editor, invoke the native Run context action
and confirm it creates or reuses a configuration for that file. Invoking the
configuration should show formatted JSON output. Also verify nested parameters,
compile/runtime failures, Stop, concurrent runs, a saved edit, and a newly
created `.fql` file. A non-Ferret file must not offer a Ferret run context.

Debug the same configuration with a persisted line breakpoint. Verify source
navigation, stepping through a function, Resume, Pause, and Stop; then add,
disable, move, remove, and mute breakpoints while running and paused. Confirm
relocation leaves the requested gutter line intact, a removed committed stop
remains suspended, and concurrent Debug and Run sessions remain independent.
Check non-ASCII source, an external runtime directory, startup failure, and
project close. Expand both scopes and nested values, select a caller frame, and
evaluate an expression in each frame. Add a watch and verify it refreshes after
stepping and the next breakpoint. Check a nine-item collection summary, an
invalid expression, an inspectable runtime failure, and a second Debug launch
after termination. Repeat inspection in two projects and close one while the
other remains suspended.

Open a non-Ferret file before `test.fql` to confirm lazy activation. Opening
additional `.fql` files in the same project should reuse the project-wide
language server. The launched executable should resolve beneath the sandbox
plugin's `ferretd/` directory rather than from `PATH`.

## Troubleshooting

- A missing or non-executable bundled daemon indicates an incomplete plugin
  archive or installation. Rebuild/reinstall it and run
  `make package-check jetbrains` to inspect the distribution.
- An unsupported-platform error includes the JVM `os.name` and `os.arch` values;
  only the six combinations listed above are packaged.
- Use **Help | Show Log in Finder** on macOS or the corresponding **Show Log**
  action on Linux and Windows to open the IDE log directory. Inspect `idea.log`
  for `com.intellij.platform.lsp`, `Ferret`, and `ferretd` messages when language
  support does not start or the server exits unexpectedly.
- Use the Ferret language-server widget in the editor status area to inspect a
  failed server and request a restart after repairing the installation. JetBrains
  owns restart behavior; the plugin does not supervise or replace the native LSP
  process.
- Execution connection and protocol failures appear in the Run console. Details,
  daemon stderr, stack traces, and cleanup failures remain in `idea.log`; the
  bearer credential is never logged. Rerunning after an execution-daemon crash
  starts a fresh project daemon, while restarting the LSP widget has no effect
  on execution.
- An immediate or unexpected daemon exit is reported by JetBrains as a stopped
  Ferret LSP server. If it repeats after a widget restart, run the installed
  binary with `--version` and reinstall the plugin when that check fails.
- Delete `extensions/jetbrains/build/` to restage plugin output. Delete the
  matching `.dist/ferretd/<version>/` entry only when a cached release artifact
  itself must be reacquired; checksum mismatches already evict corrupt archives.
