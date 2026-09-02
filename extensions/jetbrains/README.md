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
validates the installed executable, and returns its path. It never searches
`PATH`, starts `ferretd`, owns process state or streams, or registers an IntelliJ
service. The Ferret LSP descriptor constructs the `ferretd lsp` command line,
and the JetBrains LSP subsystem owns the process and protocol lifecycle.

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

Definition lookup is currently document-local. `ferretd` 1.0.0-alpha.4 does not
advertise project or module resolution, so a symbol declared in another `.fql`
file is not a supported navigation target.

Execution and debugging are not yet supported by the JetBrains integration.

## Build and test

The root Make interface is the normal contributor workflow:

```sh
make prepare jetbrains
make build jetbrains
make lint jetbrains
make test jetbrains
make package jetbrains
make package-check jetbrains
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
- An immediate or unexpected daemon exit is reported by JetBrains as a stopped
  Ferret LSP server. If it repeats after a widget restart, run the installed
  binary with `--version` and reinstall the plugin when that check fails.
- Delete `extensions/jetbrains/build/` to restage plugin output. Delete the
  matching `.dist/ferretd/<version>/` entry only when a cached release artifact
  itself must be reacquired; checksum mismatches already evict corrupt archives.
