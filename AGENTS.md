# AGENTS.md

This file is the canonical operating guide for coding agents working in the
Editorium repository. Editorium is the monorepo for official Ferret editor
integrations. Each editor package owns editor-specific adaptation and UX;
language intelligence, execution semantics, formatting semantics, and debugging
semantics remain owned by Ferret and `ferretd`.

Do not duplicate Ferret language or runtime behavior inside an editor integration
merely because the editor exposes that behavior.

## Sources of truth

Use the most direct repository authority for facts that can change:

* `Makefile` owns the public monorepo command interface.
* `tools/editorium` owns command implementation, integration discovery,
  preparation, packaging, release behavior, CI matrices, and shared acquisition
  logic behind the Make interface.
* `ferretd.json` is the sole repository pin for the `ferretd` version bundled in
  distributions and the matching Ferret daemon protocol schemas.
* `.github/workflows/*` own CI and packaging automation. The current publishing
  and release workflow is VS Code-specific.
* Each extension's manifest and build files own editor-specific metadata,
  dependencies, compatibility ranges, and package configuration.
* `tools/editorium/go.mod` owns the Go toolchain requirement, currently Go 1.26.
* `extensions/vscode/package.json` owns VS Code compatibility, dependencies, and
  npm scripts; VS Code CI currently uses Node.js 22.
* The JetBrains Gradle configuration owns the IntelliJ Platform and bytecode
  targets, currently IntelliJ Platform 2026.2 and Java 25; JetBrains CI runs on
  JDK 25.
* `shared/proto` owns editor-independent protocol inputs. VS Code currently owns
  the only generated protocol-client implementation; future consumers must own
  their output.
* Current code and tests own architecture and behavior. Historical notes, stale
  comments, old branches, and superseded scripts are not authoritative.
* `README.md` and extension-local documentation describe supported product
  behavior and development workflows.

When descriptive documentation disagrees with code, manifests, Make targets, or
CI, verify the current implementation and correct the documentation rather than
copying stale values.

## Repository architecture

Editorium is an integration monorepo. Its primary responsibility boundary is:

```text
Ferret / ferretd
    |
    | protocols and process interfaces
    v
shared inputs + Editorium tooling
    |
    +--> VS Code adapter
    +--> JetBrains adapter
    +--> future editor adapters
```

The current integration state is intentionally asymmetric:

* VS Code provides a TextMate fallback, standard LSP-backed language features
  and formatting, gRPC-backed execution, and direct per-session `ferretd dap`
  debugging.
* JetBrains registers Ferret and `.fql` files, provides bundled-binary
  distribution and current-host executable resolution, and connects local files
  to a lazy project-wide JetBrains native LSP client running `ferretd lsp`. It
  does not yet provide execution UI, debugging, or settings.
* Both integrations consume the daemon version from `ferretd.json`; neither may
  introduce a separate editor-local pin.

The following invariants apply across the repository:

* Editor integrations adapt Ferret capabilities to editor APIs; they do not
  reimplement Ferret language semantics.
* `ferretd` owns LSP behavior exposed through editor language clients.
* `ferretd` owns DAP behavior exposed through editor debugger adapters.
* Normal Ferret execution semantics belong to Ferret/`ferretd`, not editor code.
* Ferret formatting semantics belong to Ferret/`ferretd`; integrations request
  formatting rather than maintaining a competing formatter.
* Shared protocol schemas are inputs. An integration that consumes them owns its
  generated client artifacts and protocol adaptation; currently that is VS Code.
* `ferretd.json` must remain the single version pin for bundled daemon binaries
  and matching daemon schemas.
* Repository-wide build, test, package, and release behavior belongs behind the
  root Make interface.
* Editor-specific implementation details must not leak into the generic
  repository tooling unless they are represented through the integration
  adapter/catalog abstraction.
* Packaging and release behavior must be deterministic and must validate the
  artifact actually being shipped.
* Refactors must not change user-visible editor behavior accidentally.

Begin in the subsystem that owns the requested behavior:

| Concern | Primary owner |
| --- | --- |
| Public monorepo commands | `Makefile` |
| Command implementation and integration dispatch | `tools/editorium` |
| Daemon/protocol version pin | `ferretd.json` |
| Shared protocol inputs | `shared/proto` |
| VS Code integration | `extensions/vscode` |
| JetBrains integration | `extensions/jetbrains` |
| CI and VS Code publishing automation | `.github/workflows` |
| Repository-level product/development documentation | `README.md` |
| Editor-specific product/development docs | integration-local docs |

Do not duplicate an owning layer's behavior in a consumer. If generic tooling
needs editor-specific behavior, extend the integration abstraction instead of
adding scattered editor-name conditionals.

## Monorepo command discipline

GNU Make is the documented public interface for normal repository operations.

Prefer:

```text
make prepare [extension ...]
make build [extension ...]
make test [extension ...]
make lint [extension ...]
make clean [extension ...]
make package <extension>
make package-check <extension>
make install vscode [TARGET=<target>]
make test-installed vscode [TARGET=<target>]
make release vscode <version>
make proto-sync
make proto-generate vscode
make proto-check vscode
```

Rules:

* Do not introduce a second repository-level command surface in root
  `package.json`, ad-hoc shell scripts, Gradle wrappers, npm scripts, or CI-only
  commands when the operation belongs in the monorepo interface.
* Editor-local build tools remain valid implementation details. The root Make
  interface should orchestrate them through `tools/editorium`.
* New integrations must plug into the integration catalog/adapter model. Adding
  an integration must not require copying orchestration logic across Makefile or
  workflow files.
* Keep public Make targets stable unless the task explicitly changes the
  repository interface.
* Prefer extending existing verbs over inventing editor-specific top-level
  targets.
* CI should use the same underlying integration tooling as local development
  wherever practical.
* Do not move repository orchestration back into JavaScript package scripts.

Command support is not identical across integrations:

* Unscoped `make test` runs the Go tooling tests before both integration suites;
  unscoped `make lint` checks Go formatting and vet before both integration
  linters. Selecting an integration runs only that integration's operation.
* `prepare`, `build`, `test`, `lint`, `clean`, `package`, and `package-check`
  support both VS Code and JetBrains.
* `install`, `test-installed`, target-matrix generation, protobuf client
  generation/checking, and releases currently support VS Code only.
* `make ci-matrix vscode` and the Go tool's `release-ci` commands are internal CI
  entrypoints. They must remain implementations behind Make/workflows, not a
  second contributor-facing command surface.

## Toolchains

Use repository-owned toolchain declarations rather than guessing versions:

* run Go tooling with the version declared by `tools/editorium/go.mod`;
* use `npm ci` and the scripts in `extensions/vscode/package.json`; its `engines`
  field is the VS Code compatibility contract, while workflows own the Node.js
  CI version; and
* use the checked-in JetBrains Gradle wrapper. `build.gradle.kts`,
  `settings.gradle.kts`, and the JetBrains workflow own the IntelliJ, Kotlin,
  Gradle-plugin, Java, and CI JDK versions.

## Integration boundaries

### VS Code

`extensions/vscode` owns Visual Studio Code-specific adaptation, including:

* extension activation and lifecycle;
* TextMate syntax fallback;
* VS Code language-client wiring;
* execution commands and editor UX;
* debug configuration and VS Code DAP adapter wiring;
* settings and configuration;
* generated TypeScript protocol clients;
* VSIX metadata and editor-specific packaging inputs;
* VS Code-specific tests.

The language client launches `ferretd lsp`; execution uses the generated daemon,
workspace, and execution gRPC clients; and each debug session launches its own
direct `ferretd dap` adapter process. Server-backed features require file-backed
Ferret documents. Untitled Ferret documents retain declarative TextMate support
but are not sent to daemon endpoints that require file URIs.

VS Code packaging is target-specific. Each VSIX contains exactly one daemon for
one of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`,
or `win32-x64` and is written beneath `extensions/vscode/dist/`.

The VS Code extension must not independently implement semantic diagnostics,
completion, hover, navigation, Ferret formatting rules, breakpoint semantics,
stepping semantics, stack/variable semantics, or Ferret execution semantics when
those are provided by `ferretd`.

Treat editor metadata such as command IDs, configuration keys, language IDs,
debug types, context keys, publisher IDs, and package names as public
compatibility-sensitive contracts.

### JetBrains

`extensions/jetbrains` owns JetBrains Platform-specific adaptation, including:

* plugin metadata and compatibility;
* Kotlin implementation;
* Ferret file type and language registration;
* JVM host mapping and installed bundled-binary resolution;
* JetBrains native LSP provider and descriptor adaptation;
* future JetBrains actions, settings, UI, execution, and debugging integration
  when explicitly implemented;
* generated protocol clients if the integration begins consuming schemas;
* Gradle configuration and plugin packaging;
* JetBrains-specific platform, binary-resolution, and integration tests.

JetBrains packages one universal ZIP containing `ferretd` for macOS, Linux, and
Windows on arm64 and x64. Production sandbox preparation acquires and copies
that complete matrix beside the plugin's `lib/` directory. Unit-test sandbox
preparation stays independent of artifact acquisition so tests can remain
offline.

Runtime Kotlin owns only current-host mapping and installed binary resolution.
It must not launch `ferretd`, own process state or streams, or introduce an
IntelliJ service solely for executable lookup. The JetBrains LSP descriptor
constructs the `ferretd lsp` command line and lets the JetBrains LSP subsystem
own the process lifecycle. Do not search `PATH` or add fallback binaries.

Do not assume feature parity with VS Code. Implement only the capabilities
actually supported by the current JetBrains integration or required by the task.

When adding a capability already implemented in another editor, reuse the
protocol and behavioral contract, not the other editor's UI architecture.

### Shared inputs

`shared` is for editor-independent inputs, not generic application code.

Appropriate shared content includes protocol schemas and other immutable or
generated inputs that must be consumed consistently by multiple integrations.

`shared/proto/ferretd` is a synchronized, ignored schema cache. VS Code currently
generates and commits TypeScript clients from it; JetBrains does not currently
generate or consume protocol clients.

Do not move editor API wrappers, lifecycle code, UI models, or convenience
helpers into `shared` merely to reduce duplication. Similar-looking editor code
often has different lifecycle and ownership rules.

## ferretd and protocol synchronization

`ferretd.json` is the sole version pin for both bundled daemon distributions and
the corresponding daemon protocol schemas.

Rules:

* Do not add an editor-local `ferretd` version pin.
* Do not vendor a second unmanaged copy of the daemon schemas into an extension.
* `shared/proto/ferretd` is a synchronized cache, not an independent source of
  truth.
* Preserve atomic synchronization behavior: failed download, extraction,
  validation, or replacement must not corrupt a previously valid cache.
* Validate downloaded artifacts and schemas before consuming them.
* Shared acquisition uses the canonical six-target `ferretd` release model.
  Editor identifiers, JVM aliases, Go OS/architecture values, and release asset
  names are separate representations and require explicit mappings.
* Verified release artifacts are reused from
  `.dist/ferretd/<version>/<target>/`; checksum or content failures must evict
  corrupt cache entries rather than silently reusing or falling back from them.
* Generated clients belong to their extension and may be committed when the
  repository workflow requires it.
* Never hand-edit generated protocol clients.
* Change the source schema or generator inputs and regenerate.
* `proto-check` must detect drift between generated output and committed clients;
  currently only `make proto-check vscode` is implemented.
* A daemon-version update is incomplete until protocol compatibility,
  generation, packaging, and relevant integration tests have been evaluated.

Do not change protobuf definitions in Editorium to compensate for a daemon API
problem. The protocol contract is owned by the daemon/API repository.

## Generated files

Generated files are derived output.

Never hand-edit:

* generated protobuf/gRPC clients;
* bundled or compiled extension outputs;
* packaged VSIX/ZIP artifacts;
* synchronized daemon schema caches;
* other files explicitly marked as generated.

Current generated/untracked boundaries include `.dist/`,
`shared/proto/ferretd/`, `extensions/vscode/bin/`,
`extensions/vscode/dist/`, `extensions/vscode/out/`, and JetBrains Gradle
`build/` output, including staged daemon binaries and plugin ZIPs. Generated VS
Code protocol clients are the exception: they are integration-owned committed
artifacts and must be changed only through the supported generator.

Edit the owning source and use the repository-supported generator or build
command.

After generation:

* inspect the generated diff;
* ensure only expected files changed;
* verify generation is deterministic where the repository requires it;
* run the corresponding check target when one exists.

Do not commit local build outputs, staged daemon binaries, dependency caches, or
distribution artifacts unless the repository explicitly tracks them.

## Code and file organization

These rules are mandatory unless the task explicitly requires otherwise.

### General

* Organize files around clear responsibilities.
* Avoid `helpers`, `utils`, `common`, `misc`, and similarly vague dumping-ground
  modules.
* Prefer domain-specific names that make ownership obvious.
* Keep platform-specific code inside its integration.
* Do not mix unrelated lifecycle, protocol, packaging, UI, and configuration
  responsibilities in one file.
* Do not create abstractions solely because two pieces of code currently look
  similar.
* Prefer the smallest local change that fully solves the task.
* Do not perform opportunistic refactors unrelated to the requested change.

### One behavioral type per file

For TypeScript classes, Kotlin classes/objects, and Go structs with methods:

* Prefer one primary behavioral type per file.
* Keep that type's methods in the same file.
* Do not place multiple unrelated method-bearing types in one file.
* Small passive data-only types may remain together when they form one narrow
  model and have no behavior.
* Interfaces and data types that define one cohesive contract may be grouped in
  a contract/model file when that is clearer than artificial fragmentation.

### Methods and regular functions

A file centered on a class, object, or struct with methods must not also contain
unrelated top-level/package-level functions.

Top-level/package-level functions may coexist with a behavioral type only when
they are constructors/factories for that type or unavoidable platform entry
points required by the framework.

If a function conceptually belongs to a type's state, invariants, lifecycle, or
resources, make it a method.

If it is genuinely stateless package/module behavior, place it in a
responsibility-focused file rather than beside unrelated methods.

Do not keep a regular function next to methods merely because those methods are
its only callers.

## TypeScript and VS Code conventions

* Keep extension activation thin. Activation should compose services and
  register editor integrations rather than accumulate business logic.
* Prefer explicit lifecycle ownership for disposables, processes, clients,
  channels, and cancellation resources.
* Anything registered with VS Code must have a clear disposal path.
* Treat workspace, window, document, and extension-host lifecycle differences
  explicitly.
* Preserve remote-extension-host behavior. Do not accidentally assume the UI
  machine and extension host share a filesystem or executable environment.
* Do not assume every Ferret document has a file URI.
* Keep LSP transport/adaptation separate from user commands and presentation.
* Keep execution lifecycle separate from language-server lifecycle unless the
  daemon contract explicitly couples them.
* Keep debugger process lifecycle separate from long-lived language-server or
  execution-daemon lifecycle.
* Use generated protocol types instead of parallel handwritten wire models.
* Avoid `any` when the external or internal contract can be modeled precisely.
* Validate untrusted editor configuration and external process results at the
  boundary.
* Preserve command IDs and configuration keys unless an intentional migration is
  part of the task.
* Tests should exercise lifecycle and editor-facing behavior, not merely mock
  implementation details.

## Kotlin and JetBrains conventions

* Follow idiomatic Kotlin and IntelliJ Platform lifecycle patterns.
* Prefer services, listeners, extension points, and disposables appropriate to
  the JetBrains Platform rather than recreating VS Code architecture.
* Parent disposable resources correctly; do not leave listeners, processes, or
  project-scoped resources unowned.
* Keep UI-thread requirements explicit. Do not perform blocking daemon,
  filesystem, or network work on the UI thread.
* Keep project-scoped and application-scoped state separate.
* Treat plugin IDs, extension points, actions, settings keys, and compatibility
  ranges as compatibility-sensitive.
* Prefer immutable data models unless mutation is required by the platform
  lifecycle.
* Do not introduce Java merely for convenience when Kotlin already owns the
  integration.
* Avoid broad platform abstractions before multiple concrete usages justify
  them.
* Tests should verify JetBrains-specific contracts and lifecycle, not assume
  VS Code behavior.

## Go tooling conventions

`tools/editorium` is repository infrastructure, not an editor implementation.

Rules:

* Keep the Go tool generic across integrations.
* Integration-specific behavior belongs behind integration adapters/catalog
  entries.
* Do not spread `switch extensionName` or `if name == "vscode"` logic through
  unrelated packages. Centralize integration dispatch.
* Separate acquisition, validation, packaging, release, and command concerns.
* Treat filesystem mutation and archive extraction as security-sensitive.
* Validate paths before writing or extracting.
* Preserve atomic replacement where a failed operation could otherwise destroy a
  valid cache or staged artifact.
* Verify checksums for downloaded release artifacts.
* Do not silently fall back to a different daemon version or executable.
* Keep errors actionable and preserve underlying causes with idiomatic wrapping.
* Thread `context.Context` through operations that may block, spawn processes, or
  perform network/filesystem work when cancellation is meaningful.
* Avoid hidden global mutable state.
* Prefer deterministic ordering for catalogs, matrices, package contents, and
  generated output.
* Keep canonical release targets editor-neutral. VS Code target IDs and JVM/Go
  platform or architecture names must be adapted explicitly rather than treated
  as interchangeable.
* Treat shared acquisition, protocol, and release tooling as shared CI-owned
  infrastructure. Workflow path filters may exclude clearly editor-owned
  adapters, but must not classify mixed/shared tooling by only its current
  callers.

### Go file structure

For Go code in `tools/editorium`:

* Keep one struct with methods per file.
* Do not mix methods with ordinary package-level functions unless those
  functions are constructors for the file's struct.
* Move stateless package behavior to a responsibility-focused file.
* Do not create generic `helpers.go` or `utils.go`.
* Group related passive package-level types when they form one narrow contract;
  do not scatter tiny data types unnecessarily.
* Keep constructors and methods adjacent to the type they own.

## Process and resource lifecycle

Editor integrations spawn or own long-lived resources. Lifecycle behavior is a
correctness concern.

For processes, language clients, daemon connections, debug adapters, output
channels, listeners, and editor registrations:

* identify the owner;
* identify when the resource starts;
* identify when it must stop;
* make cancellation explicit;
* make repeated shutdown safe when practical;
* avoid leaking child processes after extension/plugin shutdown;
* avoid leaving stale workspace/project registrations;
* handle editor restart, reload, workspace/project close, and configuration
  changes deliberately.

Do not restart unrelated services when one configuration surface changes.

If a change intentionally invalidates active work, document and test that
behavior.

## Filesystem and remote-host behavior

Editor code must not assume all execution is local to the user's desktop.

In VS Code, Remote SSH, Dev Containers, WSL, Codespaces, and similar modes can
run the extension on a different host from the UI.

Rules:

* Resolve and execute bundled binaries on the extension/plugin host.
* Use editor APIs for workspace/document identity rather than reconstructing
  paths from display strings.
* Distinguish file URIs from untitled or virtual documents.
* Do not send a non-file document to a daemon endpoint that requires a filesystem
  path unless the protocol explicitly supports it.
* Normalize and validate external paths at process or packaging boundaries.
* Do not silently substitute another path when an explicit configured daemon
  path is invalid.

## Packaging and release discipline

Distribution logic is production code.

For packaging changes:

* preserve deterministic package contents;
* preserve the integration's distribution contract: one target-matched daemon
  per VSIX and the complete six-target daemon matrix in the universal JetBrains
  ZIP;
* validate manifest/plugin version against the intended release;
* validate target architecture/platform metadata;
* validate bundled daemon bytes/checksum where supported;
* validate executable mode on Unix targets;
* reject unsafe archive paths and malformed downloads;
* do not package local caches or unrelated build outputs.

Only VS Code currently implements releases. Local release preparation creates an
annotated `vscode/v<semver>` tag after validating a clean, synchronized `main`
checkout and the selected native/`TARGET` package. The tag-triggered release
workflow reuses VS Code validation to build and verify the complete six-target
set, creates the GitHub Release, and publishes only exact stable
`major.minor.patch` versions to the Marketplace; prereleases remain GitHub
Release artifacts. Marketplace publication currently uses the protected
`vscode-marketplace` environment's `VSCE_PAT` secret.

For VS Code release changes:

* keep release version syntax consistent with repository conventions;
* preserve the canonical integration/version tag scheme;
* validate before tagging or publishing;
* never publish or push a release from tests;
* keep credentials out of repository files and generated artifacts;
* prefer identity/federated publishing mechanisms supported by the target
  marketplace over long-lived embedded secrets;
* treat marketplace identifiers and publisher/plugin IDs as stable public
  identity.

Changes to publishing workflows require reviewing both local package validation
and remote marketplace assumptions.

## Tests and validation

Add or update tests for every behavior change.

Test at the layer that owns the contract:

* generic orchestration belongs in `tools/editorium` tests;
* VS Code lifecycle and commands belong in VS Code tests;
* JetBrains platform behavior belongs in JetBrains tests;
* generated-client drift belongs in protocol checks;
* package contents belong in package validation;
* daemon integration behavior belongs in explicit integration tests;
* release workflow logic should be validated without actually publishing.

Run the narrowest relevant command first, then broaden in proportion to risk.

Examples:

```text
make test vscode
make lint vscode

make test jetbrains
make lint jetbrains

make proto-check vscode
make package vscode TARGET=<target>
make package-check vscode TARGET=<target>

make package jetbrains
make package-check jetbrains

make test
make lint
```

Use the current `Makefile`, manifests, Gradle files, and workflows to determine
the exact supported commands.

Do not claim that tests, lint, generation, package validation, or publishing
checks passed unless they actually ran successfully.

Report unavailable tooling or environment limitations explicitly.

## Cross-editor behavior changes

When implementing the same Ferret capability in more than one editor:

1. identify the daemon/protocol contract first;
2. preserve the same language/runtime semantics;
3. adapt UX independently to each editor's conventions;
4. do not force identical internal architectures;
5. share protocol inputs, not editor lifecycle code;
6. test each editor at its own integration boundary.

A capability implemented in one editor does not automatically belong in all
others. Do not expand task scope to create parity unless requested.

## Engineering discipline

For every non-trivial change:

1. Identify the owning integration or repository subsystem.
2. Identify the external contract and current behavior being preserved or
   intentionally changed.
3. Verify whether behavior belongs in Editorium or upstream in
   Ferret/`ferretd`.
4. Choose the smallest implementation that fits the current architecture.
5. Add or update correctness tests.
6. Run the narrowest relevant validation.
7. Broaden validation according to cross-editor, packaging, protocol, or release
   risk.
8. Evaluate documentation impact.
9. Review the complete final diff using the mandatory self-review below.
10. Fix actual findings and rerun affected validation.
11. Report behavior, validation, documentation, review results, and limitations
    accurately.

A task is not complete merely because the first implementation compiles or its
tests pass.

Do not introduce speculative abstractions, package moves, framework migrations,
or editor parity work unrelated to the requested change.

## Mandatory final self-review

After implementation and initial validation, review the complete resulting
change before considering any non-trivial task finished.

### Correctness and lifecycle

Verify the requested behavior is completely satisfied.

Look for:

* leaked processes, clients, listeners, subscriptions, or disposables;
* stale project/workspace registrations;
* cancellation races;
* shutdown/restart errors;
* platform-specific path mistakes;
* remote-host assumptions;
* invalid handling of untitled or virtual documents;
* incorrect daemon/version selection;
* lost underlying errors;
* incorrect configuration precedence;
* accidental fallback behavior;
* missing negative or boundary cases.

For bug fixes, prefer a regression test that fails without the fix.

### Architecture and ownership

Verify behavior remains in the correct layer.

Reject:

* Ferret semantic logic copied into an editor;
* DAP or LSP semantics recreated outside `ferretd`;
* editor-specific behavior leaking into generic tooling without an adapter;
* a second daemon version pin;
* unmanaged schema copies;
* cross-editor shared code that actually contains editor lifecycle assumptions;
* unnecessary public extension points;
* duplicated packaging/release logic.

### Clarity and organization

Look for:

* oversized activation/entry-point files;
* unrelated responsibilities in one file;
* multiple behavioral types packed together;
* ordinary functions mixed into method-bearing files;
* vague helper modules;
* duplicated lifecycle logic;
* misleading names;
* dead branches;
* temporary debugging output;
* comments describing abandoned approaches.

Enforce the language-specific file organization rules above.

### Tests, generation, and packages

Review whether tests cover meaningful positive, negative, lifecycle, error, and
cancellation behavior.

For generated or packaged output, verify:

* generated files came from the correct source;
* generated drift checks pass where required;
* package contents are exact;
* no local caches or unrelated binaries are included;
* target-specific package metadata is correct;
* daemon version/schema/package assumptions agree.

### Complete diff

Inspect the complete final diff, not only individual files.

Verify that:

* every changed line belongs to the request or a necessary supporting change;
* no unrelated refactor remains;
* no accidental public command, setting, command ID, plugin ID, or package ID
  change remains;
* generated files changed only because their source inputs changed;
* manifests and documentation match behavior;
* CI uses the intended repository interfaces;
* resource ownership remains clear;
* editor-specific and generic boundaries remain coherent;
* the final solution is the smallest complete implementation.

When review finds a correctness, lifecycle, architecture, ownership, packaging,
protocol, security, documentation, organization, or meaningful coverage problem,
fix it and rerun affected validation.

Minor optional style preferences do not justify churn.

## Documentation synchronization

Documentation is part of the change.

Before completing every non-trivial task, evaluate whether the implementation
changes any documented:

* feature or editor capability;
* command or workflow;
* setting;
* extension/plugin behavior;
* daemon requirement;
* protocol workflow;
* packaging or release process;
* supported platform or target;
* architecture or subsystem responsibility.

Update the relevant repository or integration-local documentation in the same
task.

Do not update documentation mechanically when behavior or guidance did not
change.

If a change affects public Ferret documentation maintained in another
repository, identify the exact required follow-up in the final report when that
repository is unavailable.

## Change and reporting discipline

Prefer an existing local pattern over a new architectural pattern.

Leave already-correct code alone.

If requested work exposes a necessary supporting cleanup, keep it narrow and
explain why it is required.

The final report for a non-trivial change must state:

* owning subsystem/integration and files changed;
* behavior and invariants preserved or intentionally changed;
* tests added or updated;
* generation/package checks performed when applicable;
* validation commands actually run;
* documentation updated, or documentation impact evaluated as none;
* completion of the mandatory final self-review;
* material findings corrected during review;
* remaining limitations or skipped validation.

Do not claim success for anything that was not actually validated.

## Response style

Keep responses practical and easy to scan.

Use short sections, focused bullets, and code blocks only for code, commands, or
configuration. Explain why a change is needed before how it works. Summarize each
changed file's responsibility and avoid repeating the same context.
