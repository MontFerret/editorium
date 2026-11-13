import java.io.ByteArrayOutputStream
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginStructureTask
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm")
    id("org.jetbrains.intellij.platform")
}

group = "org.ferretlang.jetbrains"
version = providers.gradleProperty("pluginVersion").get()

dependencies {
    implementation(platform("io.grpc:grpc-bom:1.84.0"))
    implementation("io.grpc:grpc-netty-shaded")
    implementation("io.grpc:grpc-protobuf")
    implementation("io.grpc:grpc-stub")
    implementation("com.google.protobuf:protobuf-java:4.36.1")
    implementation("org.eclipse.lsp4j:org.eclipse.lsp4j.debug:0.24.0")

    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        intellijIdea("2026.2.0.1")
        bundledModule("intellij.platform.debugger")
        testFramework(TestFrameworkType.Platform)
        zipSigner("0.1.45")
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
        }
    }
    pluginVerification {
        failureLevel = listOf(
            VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            VerifyPluginTask.FailureLevel.DEPRECATED_API_USAGES,
            VerifyPluginTask.FailureLevel.INTERNAL_API_USAGES,
            VerifyPluginTask.FailureLevel.OVERRIDE_ONLY_API_USAGES,
            VerifyPluginTask.FailureLevel.SCHEDULED_FOR_REMOVAL_API_USAGES,
        )
        ides {
            create(IntelliJPlatformType.IntellijIdea, "2026.2.0.1")
            create(IntelliJPlatformType.IntellijIdea, "2026.3")
            create(IntelliJPlatformType.GoLand, "2026.2.4")
            create(IntelliJPlatformType.GoLand, "2026.3")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_25
        allWarningsAsErrors = true
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}

sourceSets {
    main {
        java.srcDir("src/main/generated")
    }
}

val repositoryRoot = layout.projectDirectory.dir("../..")
val generatedFerretdDirectory = layout.buildDirectory.dir("generated/ferretd")
val prepareFerretd = tasks.register<Exec>("prepareFerretd") {
    group = "build"
    description = "Acquires and stages the pinned ferretd release for JetBrains packaging."

    workingDir(repositoryRoot.dir("tools/editorium"))
    commandLine("go", "run", ".", "run", "prepare", "jetbrains")

    inputs.file(repositoryRoot.file("ferretd.json"))
    inputs.files(
        repositoryRoot.dir("tools/editorium").asFileTree.matching {
            include("*.go", "go.mod", "go.sum")
        },
    )
    outputs.dir(generatedFerretdDirectory)
}

val releaseCommit = providers.environmentVariable("JETBRAINS_RELEASE_COMMIT").filter { it.isNotBlank() }
val releaseInput = providers.environmentVariable("JETBRAINS_UNSIGNED_ZIP").map { File(it) }
val releaseOutput = providers.environmentVariable("JETBRAINS_SIGNED_ZIP").map { File(it) }
val signingKey = providers.environmentVariable("JETBRAINS_SIGNING_KEY_FILE").map { File(it) }
val signingCertificate = providers.environmentVariable("JETBRAINS_CERTIFICATE_FILE").map { File(it) }

tasks {
    named<org.gradle.jvm.tasks.Jar>("composedJar") {
        inputs.property("releaseCommit", releaseCommit).optional(true)
        releaseCommit.orNull?.let { manifest.attributes("Ferret-Release-Commit" to it) }
    }
    signPlugin {
        archiveFile.fileProvider(releaseInput)
        signedArchiveFile.fileProvider(releaseOutput)
        privateKeyFile.fileProvider(signingKey)
        certificateChainFile.fileProvider(signingCertificate)
    }
    verifyPluginSignature {
        inputArchiveFile.fileProvider(releaseOutput)
        certificateChainFile.fileProvider(signingCertificate)
    }
    withType<Test>().configureEach {
        testLogging.exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
    test {
        useJUnit {
            excludeCategories("org.ferretlang.jetbrains.integration.FerretdIntegrationTest")
        }
    }
    named<PrepareSandboxTask>("prepareSandbox") {
        dependsOn(prepareFerretd)
        from(generatedFerretdDirectory) {
            into(pluginName.map { "$it/ferretd" })
            filesMatching("darwin/**/ferretd") {
                permissions { unix("rwxr-xr-x") }
            }
            filesMatching("linux/**/ferretd") {
                permissions { unix("rwxr-xr-x") }
            }
        }
    }
    buildPlugin {
        archiveFileName = "ferret-jetbrains-${project.version}.zip"
        filesMatching("**/ferretd/darwin/**/ferretd") {
            permissions { unix("rwxr-xr-x") }
        }
        filesMatching("**/ferretd/linux/**/ferretd") {
            permissions { unix("rwxr-xr-x") }
        }
    }
    withType<VerifyPluginStructureTask>().configureEach {
        ignoreWarnings = false
    }
}

val wireHostSources = repositoryRoot.dir("fixtures/wire-host")
val wireHostName = if (System.getProperty("os.name").startsWith("Windows")) "wire-host.exe" else "wire-host"
val wireHostBinary = layout.buildDirectory.file("test-fixtures/$wireHostName")
val buildWireHost = tasks.register<Exec>("buildWireHost") {
    workingDir(wireHostSources)
    environment("GOWORK", "off")
    inputs.files(wireHostSources.asFileTree.matching { include("*.go", "go.mod", "go.sum") })
    inputs.file(repositoryRoot.file("ferretd.json"))
    inputs.property("os", System.getProperty("os.name"))
    inputs.property("architecture", System.getProperty("os.arch"))
    outputs.file(wireHostBinary)
    commandLine("go", "build", "-mod=readonly", "-o", wireHostBinary.get().asFile, ".")
}

// Compare the modules actually linked into the two executables, including release builds.
abstract class VerifyWireHost : DefaultTask() {
    @get:InputFile abstract val daemon: RegularFileProperty
    @get:InputFile abstract val fixture: RegularFileProperty
    @get:Inject abstract val exec: ExecOperations

    private fun modules(file: File): Map<String, String> {
        val output = ByteArrayOutputStream()
        exec.exec {
            commandLine("go", "version", "-m", file)
            standardOutput = output
        }
        return output.toString(Charsets.UTF_8).lineSequence().map { it.trim().split('\t') }
            .filter { it.size >= 3 && it[0] == "dep" }.associate { it[1] to it[2] }
    }

    @TaskAction fun verify() {
        val executable = daemon.get().asFile
        check(executable.canExecute()) { "FERRETD_TEST_PATH is not executable: $executable" }
        val expected = modules(executable)
        val actual = modules(fixture.get().asFile)
        for (module in listOf("github.com/MontFerret/ferret/v2", "github.com/MontFerret/api", "github.com/MontFerret/wire")) {
            check(expected[module] != null && actual[module] == expected[module]) {
                "$module dependency mismatch: ferretd=${expected[module]}, fixture=${actual[module]}"
            }
        }
    }
}

val testDaemon = providers.environmentVariable("FERRETD_TEST_PATH").map { File(it) }
val verifyWireHost = tasks.register<VerifyWireHost>("verifyWireHost") {
    dependsOn(buildWireHost)
    daemon.fileValue(testDaemon.orNull ?: throw GradleException("FERRETD_TEST_PATH is required."))
    fixture.set(wireHostBinary)
}

intellijPlatformTesting.testIde.register("ferretdIntegrationTest") {
    testFramework(TestFrameworkType.Platform)
    task {
        group = "verification"
        description = "Runs JetBrains integration tests against the pinned daemon and an owned Wire host."
        dependsOn(verifyWireHost)
        inputs.file(testDaemon).withPropertyName("pinnedFerretd")
        inputs.file(repositoryRoot.file("ferretd.json"))
        inputs.file(wireHostBinary)
        inputs.files(wireHostSources.asFileTree.matching { include("*.go", "go.mod", "go.sum") })
        environment("FERRET_TEST_WIRE_HOST", wireHostBinary.get().asFile.absolutePath)
        val passiveHostLoss = providers.environmentVariable("FERRET_TEST_PASSIVE_HOST_LOSS").orElse("0")
        inputs.property("passiveHostLoss", passiveHostLoss)
        environment("FERRET_TEST_PASSIVE_HOST_LOSS", passiveHostLoss.get())
        outputs.upToDateWhen { false }
        outputs.doNotCacheIf("Live tests exercise newly started processes") { true }
        useJUnit {
            includeCategories("org.ferretlang.jetbrains.integration.FerretdIntegrationTest")
        }
    }
}
