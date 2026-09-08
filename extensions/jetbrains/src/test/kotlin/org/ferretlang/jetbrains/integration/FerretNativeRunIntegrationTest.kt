package org.ferretlang.jetbrains.integration

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
import org.ferretlang.jetbrains.daemon.FerretdInstallation
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunConfigurationType
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@Category(FerretdIntegrationTest::class)
class FerretNativeRunIntegrationTest : BasePlatformTestCase() {
    fun testNativeRunnerSavesTheEditedDocumentAndTerminatesWithoutStop() {
        val executable = Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH")))
        val version = runBlocking(Dispatchers.IO) {
            val process = ProcessBuilder(executable.toString(), "--version").start()
            val output = process.inputStream.bufferedReader().readText().trim()
            check(process.waitFor(5, TimeUnit.SECONDS) && process.exitValue() == 0)
            output.removePrefix("ferretd ").trim()
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val connection = FerretdDaemonConnection.testing(scope, FerretdInstallation(executable, version))
        project.replaceService(FerretdDaemonConnection::class.java, connection, testRootDisposable)
        val path = Path.of(requireNotNull(project.basePath)).resolve("native-unsaved.fql")
        Files.createDirectories(path.parent)
        Files.writeString(path, "RETURN missing")
        val file = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
        val documents = FileDocumentManager.getInstance()
        val document = requireNotNull(documents.getDocument(file))
        val configuration = FerretRunConfigurationType.getInstance().configurationFactories.single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
        configuration.sourcePath = path.toString()
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
