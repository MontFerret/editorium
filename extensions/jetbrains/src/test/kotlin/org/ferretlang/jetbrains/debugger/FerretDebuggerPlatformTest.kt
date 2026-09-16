package org.ferretlang.jetbrains.debugger

import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ProgramRunner
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.LightVirtualFile
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.XDebuggerUtil
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.eclipse.lsp4j.debug.Source
import org.ferretlang.jetbrains.lang.FerretLanguageFileType
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunConfigurationType
import java.nio.file.Path

class FerretDebuggerPlatformTest : BasePlatformTestCase() {
    fun testDebugRunnerUsesTheExistingConfigurationAndRejectsTheRunExecutor() {
        val configuration = configuration()
        val runner = requireNotNull(ProgramRunner.getRunner(DefaultDebugExecutor.EXECUTOR_ID, configuration))
        assertTrue(runner is FerretDebugRunner)
        assertFalse(runner.canRun(DefaultRunExecutor.EXECUTOR_ID, configuration))
    }

    fun testBreakpointTypeIsRegisteredAndRejectsVirtualAndUnrelatedFiles() {
        val type = XDebuggerUtil.getInstance().findBreakpointType(FerretBreakpointType::class.java)
        val file = myFixture.tempDirFixture.createFile("source.fql", "RETURN 1")
        assertEquals("ferret-line", type.id)
        assertTrue(type.canPutAt(file, 0, project))
        assertFalse(type.canPutAt(file, -1, project))
        assertFalse(type.canPutAt(myFixture.tempDirFixture.createFile("readme.txt"), 0, project))
        assertFalse(type.canPutAt(LightVirtualFile("virtual.fql", FerretLanguageFileType, "RETURN 1"), 0, project))
        assertTrue(type.canBeHitInOtherPlaces())
        assertTrue(type.visibleStandardPanels.isEmpty())
        val manager = XDebuggerManager.getInstance(project).breakpointManager
        WriteCommandAction.runWriteCommandAction(project) {
            val breakpoint = manager.addLineBreakpoint<XBreakpointProperties<*>>(type, file.url, 0, null)
            assertTrue(manager.getBreakpoints(type).contains(breakpoint))
            assertEquals(com.intellij.xdebugger.breakpoints.SuspendPolicy.ALL, breakpoint.suspendPolicy)
            assertNull(type.getEditorsProvider(breakpoint, project))
            manager.removeBreakpoint(breakpoint)
        }
    }

    fun testPositionsConsumeUtf16ColumnsAndResolveRelativePathsWithoutGuessing() {
        val file = localFile("unicode.fql", "LET text = \"😀\" RETURN text\nRETURN text")
        val positions = FerretSourcePositions(file.toNioPath().parent)
        // Release the test EDT's write-intent lock before background read actions.
        val task = com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            runBlocking(Dispatchers.IO) {
                val source = Source().apply { path = "unicode.fql" }
                val position = requireNotNull(positions.position(source, 1, 17))
                assertEquals(file, position.file)
                assertEquals(0, position.line)
                assertEquals(16, position.offset)
                assertNull(positions.position(Source().apply { path = "missing.fql" }, 1, 1))
                assertNull(positions.position(Source().apply { sourceReference = 3 }, 1, 1))
                assertNull(positions.position(source, 0, 1))
                assertNull(positions.position(source, 20, 1))
                assertNull(positions.position(source, 1, 200))
            }
        }
        com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("Source positions did not resolve", { task.isDone }, 10)
        task.get()
    }

    fun testDebugRejectsAnUnsavedSourceUsingTheSharedCheck() {
        val file = localFile("dirty.fql", "RETURN 1")
        val configuration = configuration().apply { sourcePath = file.path }
        val documents = FileDocumentManager.getInstance()
        val document = requireNotNull(documents.getDocument(file))
        try {
            WriteCommandAction.runWriteCommandAction(project) { document.setText("RETURN 2") }
            try {
                org.ferretlang.jetbrains.launch.FerretLaunchInputResolver.checkSavedSource(configuration.launchInput())
                fail("Unsaved source must be rejected for Debug too")
            } catch (error: com.intellij.execution.ExecutionException) {
                assertTrue(error.message.orEmpty().contains("could not save"))
            }
            assertNotNull(configuration.getState(DefaultDebugExecutor.getDebugExecutorInstance(), ExecutionEnvironment()))
        } finally {
            documents.saveDocument(document)
        }
    }

    private fun configuration(): FerretRunConfiguration = FerretRunConfigurationType.getInstance()
        .configurationFactories.single().createTemplateConfiguration(project) as FerretRunConfiguration

    private fun localFile(name: String, text: String): com.intellij.openapi.vfs.VirtualFile {
        val path = Path.of(requireNotNull(project.basePath)).resolve(name)
        java.nio.file.Files.createDirectories(path.parent)
        java.nio.file.Files.writeString(path, text)
        return requireNotNull(com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
    }
}
