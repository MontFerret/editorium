# Ferret for JetBrains IDEs

This module is the JetBrains IDE integration for Ferret Query Language files.
It registers `.fql` files, provides language intelligence through JetBrains'
native LSP support, and executes queries through native Ferret Run configurations.
The plugin bundles the required `ferretd` executable.

## Prerequisites

- Go 1.26 or newer for the shared Editorium distribution tool;
- a JDK 21 or newer to run Gradle;
- network access on the first build for Gradle, JetBrains dependencies, and the
  pinned `ferretd` release; and
- enough disk space for the IntelliJ Platform development distribution and six
  native daemon artifacts.

IntelliJ Platform 2026.2 compiles and runs on Java 25. The Gradle build uses the
Foojay resolver to provision that toolchain automatically when it is not
installed locally. Ferret plugin bytecode also targets Java 25.

Use the checked-in Gradle wrapper; a system Gradle installation is not needed.

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

Definition lookup is currently document-local. `ferretd` 1.0.0-alpha.6 does not
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

- **Source file**: the `.fql` file to execute. The chooser filters for Ferret
  files, while a path entered by hand may be absolute or relative to the
  project base directory.
- **Working directory**: the root used by Ferret runtime filesystem operations.
  It defaults to the project base directory when one exists, may be overridden
  with an absolute or project-relative path anywhere on the local filesystem,
  and may be left empty to use the daemon's workspace-root default.
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
the plugin snapshots the configuration and resolves existing paths to their
canonical locations. The compilation workspace is the project base directory
when one exists, otherwise the canonical source parent. A present project base
must be a readable directory containing the source; the plugin does not fall
back when it is invalid. Relative configured paths require a project base.

The runtime working directory is resolved and validated independently. It may
be outside the workspace and does not participate in source containment or
relative source identity. Leaving it blank omits the execution option, causing
the daemon to use the workspace root. These execution-time checks do not
rewrite the saved configuration.

Run configurations use JetBrains' normal project persistence and survive IDE
restart, project reopen, and configuration duplication. IDE rename/move
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
Filesystem and daemon work continues off the UI thread. Parameter nulls,
booleans, finite numbers, strings, arrays, and objects retain their types. The
console shows formatted JSON results, actionable compile/runtime diagnostics,
and concise completion or cancellation feedback. Results arrive when the query
finishes; there is no incremental program output. Startup details and transport
diagnostics stay in the IDE log.

The first Run lazily starts a dedicated execution daemon for that project.
Opening a Ferret file may start language support but does not start execution
infrastructure. Subsequent runs reuse the execution daemon; concurrent runs
have independent parameters, results, working directories, and cancellation.
Different projects own separate execution daemons.

**Stop**, detach, and Run-tab closure cancel only that invocation. Successful
runs exit 0, failures exit 1, and a locally requested cancellation exits 130. A
daemon crash fails current runs and clears its workspace cache; only a later Run
starts a new daemon. The project service shuts its execution daemon down with
the project.

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

`verifyPlugin` checks the archive against IntelliJ Platform 2026.2. The root
package check additionally verifies every bundled daemon's bytes, version, and
Unix executable mode and runs the native daemon's `--version` smoke check.

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
