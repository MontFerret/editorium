# Ferret for JetBrains IDEs

This module is the JetBrains IDE integration for Ferret Query Language files.
Its current scope is deliberately limited to registering Ferret and recognizing
the `.fql` file extension with Ferret branding.

Language intelligence remains owned by `ferretd`. This foundation does not
include LSP integration, daemon discovery or packaging, parsing, PSI, syntax
highlighting, completion, diagnostics, formatting, execution, run
configurations, or debugging.

## Prerequisites

- a JDK 21 or newer to run Gradle;
- network access on the first build for Gradle and JetBrains dependencies; and
- enough disk space for the IntelliJ Platform development distribution.

IntelliJ Platform 2026.2 compiles and runs on Java 25. The Gradle build uses the
Foojay resolver to provision that toolchain automatically when it is not
installed locally. Ferret plugin bytecode also targets Java 25.

Use the checked-in Gradle wrapper; a system Gradle installation is not needed.

## Build and test

The root Make interface is the normal contributor workflow:

```sh
make prepare jetbrains
make build jetbrains
make lint jetbrains
make test jetbrains
make package jetbrains
```

`prepare` is intentionally a no-op because this module has no external runtime
or generated protocol inputs. The distributable archive is written to:

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

`verifyPlugin` checks the archive against the configured IntelliJ Platform
2026.2 target. The plugin descriptor uses only the platform and language
modules; it does not declare dependencies on Java support or an individual IDE
product.

## Launch a development IDE

Run the standard IntelliJ Platform development task:

```sh
cd extensions/jetbrains
./gradlew runIde
```

In the sandbox IDE:

1. Create or open `test.fql`.
2. Confirm the file type is **Ferret**.
3. Confirm the Ferret icon appears in the Project tool window and editor tab.

No `ferretd` executable is required for this workflow. The editor will not
provide language intelligence until a later task adds the native LSP client
integration.
