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
version = "0.1.0"

dependencies {
    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        intellijIdea("2026.2.0.1")
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "262"
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
            current()
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

tasks {
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
