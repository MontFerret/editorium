# Ferret for JetBrains IDEs

This module is the JetBrains IDE integration for Ferret Query Language files.
It registers the Ferret language and `.fql` file type and bundles the `ferretd`
process infrastructure required by the upcoming language-server integration.
It does not yet start the daemon automatically or implement LSP features.

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

At runtime, a lazy project service maps the JVM OS and architecture to this
layout. It never searches `PATH`. A started `ferretd lsp` process belongs to its
project and is stopped when the service, project, plugin, or IDE is disposed.
No process is started merely because the plugin loads.

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
and icon. Language intelligence remains unavailable until the later LSP task
requests the lazy daemon service.

## Troubleshooting

- A missing or non-executable bundled daemon indicates an incomplete plugin
  archive or installation. Rebuild/reinstall it and run
  `make package-check jetbrains` to inspect the distribution.
- An unsupported-platform error includes the JVM `os.name` and `os.arch` values;
  only the six combinations listed above are packaged.
- An immediate startup failure is recorded in the IDE log with the exit code
  and bounded `ferretd` stderr. Protocol stdout is intentionally not logged.
- Delete `extensions/jetbrains/build/` to restage plugin output. Delete the
  matching `.dist/ferretd/<version>/` entry only when a cached release artifact
  itself must be reacquired; checksum mismatches already evict corrupt archives.
