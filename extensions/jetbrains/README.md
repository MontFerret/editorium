# Ferret for JetBrains IDEs

This module is the JetBrains IDE integration for Ferret Query Language files.
It registers the Ferret language and `.fql` file type, bundles `ferretd`, and
connects file-backed Ferret documents to the daemon through the IntelliJ
Platform's native Language Server Protocol support.

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

Definition lookup is currently document-local. `ferretd` 1.0.0-alpha.5 does not
advertise project or module resolution, so a symbol declared in another `.fql`
file is not a supported navigation target.

## Run configurations

The plugin provides a native **Ferret** Run Configuration for describing a
Ferret Query Language execution. Open **Run | Edit Configurations**, select
**Add New Configuration**, and choose **Ferret**. Each configuration contains:

- **Source file**: the `.fql` file to execute. The chooser filters for Ferret
  files, while a path entered by hand may be absolute or relative to the
  project base directory.
- **Working directory**: the execution directory, defaulting to the project
  base directory when one exists. It may be overridden with an absolute path
  or a project-relative path, and may be left empty for projects without a base
  directory.
- **Parameters (JSON object)**: FQL bind parameter values using the same JSON
  object shape as the Ferret execution protocol. For example:

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
  are rejected.

The source file is required; the working directory is optional. At every Run,
the plugin snapshots the configuration and resolves existing paths to their
canonical locations. The effective working directory is the configured value,
then the project base directory, then the canonical source parent. Relative
configured paths require a project base directory. The source must be a
readable regular file inside the readable effective directory; symlink escapes
and sources outside that directory are rejected without rewriting the saved
configuration.

Run configurations use JetBrains' normal project persistence and survive IDE
restart, project reopen, and configuration duplication. Opening a local `.fql`
file also enables the standard Run context action, which creates or reuses a
Ferret configuration named after that file. Other file types do not offer a
Ferret configuration.

Running a configuration immediately opens the normal JetBrains Run console.
Filesystem and daemon work continues off the UI thread. Parameter nulls,
booleans, finite numbers, strings, arrays, and objects retain their protocol
types. The console shows the canonical source and effective directory, status,
formatted `application/json` terminal output, and actionable compile/runtime
diagnostics. Protocol v1 exposes only terminal output, so the plugin does not
present fabricated incremental stdout.

The first Run in a project lazily starts the bundled daemon as an authenticated
IPv4-loopback service on an operating-system-assigned port. The plugin validates
the ready event, packaged version, nonempty instance ID, and API 1.1 before use.
Workspaces are cached by canonical root within that daemon generation, while
every invocation gets a fresh Session, Execution, watch, output sink, and
cancellation state. This refreshes saved edits and new files and permits
unrestricted concurrent runs.

**Stop**, detach, and Run-tab closure cancel only that invocation. Successful
runs exit 0, failures exit 1, and a locally requested cancellation exits 130. A
daemon crash fails current runs and clears its workspace cache; only a later Run
starts a new daemon. The project service shuts its execution daemon down with
the project. JetBrains debugging is not yet supported.

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
