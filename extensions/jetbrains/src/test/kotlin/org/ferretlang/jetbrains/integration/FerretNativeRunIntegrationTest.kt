package org.ferretlang.jetbrains.integration

import com.google.gson.JsonParser
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.replaceService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunConfigurationType
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference

@Category(FerretdIntegrationTest::class)
class FerretNativeRunIntegrationTest : BasePlatformTestCase() {
    fun testHostedSelectionsReachNativeRunConsoleAndReleaseConnection() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val connection = FerretdDaemonConnection.testing(scope, pinnedTestInstallation())
        project.replaceService(FerretdDaemonConnection::class.java, connection, testRootDisposable)
        val root = Files.createDirectories(Path.of(requireNotNull(project.basePath)).resolve(".tmp/native-wire"))
        val hosted = Files.writeString(root.resolve("query.fql"), "RETURN DEMO::IDENTITY(@value)")
        val local = Files.writeString(root.resolve("local.fql"), "RETURN \"local marker\"")
        val config = root.resolve("runtimes.json")
        val value = """{"number":42,"flag":true,"text":"42"}"""
        val bindings = """{"value":$value}"""
        val executor = DefaultRunExecutor.getRunExecutorInstance()
        try {
            WireHost.start(root).use { host ->
                connection.applyConfigPath(host.configure(config).toString())
                for ((ordinal, selector) in listOf("", "App").withIndex()) {
                    if (selector == "App") {
                        host.configure(config, default = "local")
                        runBlocking { connection.reloadRuntimes().join() }
                    }
                    NativeFerretLaunch(project, executor).use { launch ->
                        launch.start(hosted, selector, bindings)
                        val lines = launch.outputLines()
                        val start = lines.indexOfFirst { it.startsWith("{") }
                        val end = lines.indexOfLast { it.endsWith("}") }
                        check(start >= 0 && end >= start) { "Missing native JSON result: $lines" }
                        val output = lines.subList(start, end + 1).joinToString("\n")
                        assertEquals("Parameter types in native Run output", JsonParser.parseString(value), JsonParser.parseString(output))
                    }
                    host.released(host.connection(ordinal + 1))
                    PlatformTestUtil.waitWithEventsDispatching("Run admission was not released", { !connection.catalogState.value.busy }, 10)
                    if (selector.isEmpty()) {
                        NativeFerretLaunch(project, executor).use { launch ->
                            launch.start(local, "local", "{}")
                            assertTrue(launch.outputLines().any { it.contains("local marker") })
                        }
                        assertEquals(1, host.count("connected"))
                    }
                }
            }
        } finally {
            runBlocking { connection.closeForTest() }
            scope.cancel()
        }
    }

    fun testNativeRunnerSavesTheEditedDocumentAndTerminatesWithoutStop() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val connection = FerretdDaemonConnection.testing(scope, pinnedTestInstallation())
        project.replaceService(FerretdDaemonConnection::class.java, connection, testRootDisposable)
        val path = Path.of(requireNotNull(project.basePath)).resolve(".tmp/test.fql")
        Files.createDirectories(path.parent)
        Files.writeString(path, "RETURN missing")
        val file = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
        val documents = FileDocumentManager.getInstance()
        val document = requireNotNull(documents.getDocument(file))
        val configuration = FerretRunConfigurationType.getInstance().configurationFactories.single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
        configuration.sourcePath = path.toString()
        val runtimeConfig = Files.writeString(path.resolveSibling("runtimes.json"), "{}")
        connection.applyConfigPath(runtimeConfig.toString())
        configuration.runtimeName = "local"
        configuration.workingDirectory = ""
        configuration.setGeneratedName()
        val content = AtomicReference<RunContentDescriptor>()
        val failure = AtomicReference<Throwable>()
        try {
            WriteCommandAction.runWriteCommandAction(project) { document.setText("RETURN 2") }
            assertTrue(documents.isDocumentUnsaved(document))
            val environment = ExecutionEnvironmentBuilder.create(DefaultRunExecutor.getRunExecutorInstance(), configuration)
                .build(object : ProgramRunner.Callback {
                    override fun processStarted(descriptor: RunContentDescriptor) { content.set(descriptor) }
                    override fun processNotStarted(error: Throwable?) { failure.set(error ?: IllegalStateException("Run did not start")) }
                })
            environment.runner.execute(environment)
            PlatformTestUtil.waitWithEventsDispatching("Native Ferret Run did not finish", {
                failure.get() != null || content.get()?.processHandler?.isProcessTerminated == true
            }, 20)
            failure.get()?.let { throw AssertionError("Native Ferret Run failed", it) }
            assertFalse(documents.isDocumentUnsaved(document))
            assertEquals("RETURN 2", Files.readString(path))
            assertEquals(0, requireNotNull(content.get()?.processHandler).exitCode)
            val generation = runBlocking { connection.generation() }
            runBlocking { connection.closeForTest() }
            assertFalse(generation.process.isAlive)
        } finally {
            runBlocking { connection.closeForTest() }
            scope.cancel()
            documents.saveDocument(document)
        }
    }
}
