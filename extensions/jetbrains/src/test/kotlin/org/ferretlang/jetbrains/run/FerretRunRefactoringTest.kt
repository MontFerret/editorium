package org.ferretlang.jetbrains.run

import com.intellij.execution.RunManager
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiManager
import com.intellij.refactoring.move.moveFilesOrDirectories.MoveFilesOrDirectoriesProcessor
import com.intellij.refactoring.rename.RenameProcessor
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files
import java.nio.file.Path

class FerretRunRefactoringTest : BasePlatformTestCase() {
    fun testNativeRenameUpdatesRegisteredConfigurationAndPreservesOtherFields() {
        val base = Path.of(requireNotNull(project.basePath))
        val path = base.resolve("refactoring/query.fql")
        Files.createDirectories(path.parent)
        Files.writeString(path, "RETURN 1")
        val file = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
        val psi = requireNotNull(PsiManager.getInstance(project).findFile(file))
        val manager = RunManager.getInstance(project)
        val settings = manager.createConfiguration("query", FerretRunConfigurationType.getInstance().configurationFactories.single())
        val configuration = settings.configuration as FerretRunConfiguration
        configuration.sourcePath = "refactoring/query.fql"
        configuration.workingDirectory = "runtime"
        configuration.parametersJson = "{\"value\":[true,null,3]}"
        configuration.setGeneratedName()
        manager.addConfiguration(settings)
        try {
            RenameProcessor(project, psi, "renamed.fql", false, false).run()
            assertEquals(Path.of("refactoring", "renamed.fql").toString(), configuration.sourcePath)
            assertEquals("refactoring/renamed.fql", configuration.name)
            assertEquals("runtime", configuration.workingDirectory)
            assertEquals("{\"value\":[true,null,3]}", configuration.parametersJson)
            val undo = UndoManager.getInstance(project)
            TestDialogManager.setTestDialog(TestDialog.OK, testRootDisposable)
            assertTrue(undo.isUndoAvailable(null))
            undo.undo(null)
            assertEquals("refactoring/query.fql", configuration.sourcePath)
            assertEquals("refactoring/query.fql", configuration.name)
            assertEquals("query.fql", file.name)
            undo.redo(null)
            assertEquals(Path.of("refactoring", "renamed.fql").toString(), configuration.sourcePath)
            assertEquals("refactoring/renamed.fql", configuration.name)
        } finally {
            manager.removeConfiguration(settings)
        }
    }

    fun testAncestorMoveAndUndoPreserveAbsoluteSourceAndCustomName() {
        val base = Path.of(requireNotNull(project.basePath))
        val path = base.resolve("move-source/nested/query.fql")
        Files.createDirectories(path.parent)
        Files.writeString(path, "RETURN 1")
        val source = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
        val folder = source.parent.parent
        val psi = requireNotNull(PsiManager.getInstance(project).findDirectory(folder))
        val manager = RunManager.getInstance(project)
        val settings = manager.createConfiguration("My query", FerretRunConfigurationType.getInstance().configurationFactories.single())
        val configuration = settings.configuration as FerretRunConfiguration
        configuration.sourcePath = path.toString()
        configuration.name = "My query"
        configuration.setNameChangedByUser(true)
        manager.addConfiguration(settings)
        Files.createDirectories(base.resolve("destination"))
        val target = requireNotNull(PsiManager.getInstance(project).findDirectory(
            requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(base.resolve("destination"))),
        ))
        try {
            MoveFilesOrDirectoriesProcessor(project, arrayOf(psi), target, false, false, null, null).run()
            val movedPath = base.resolve("destination/move-source/nested/query.fql").toString()
            assertEquals(movedPath, configuration.sourcePath)
            assertEquals("My query", configuration.name)
            val undo = UndoManager.getInstance(project)
            TestDialogManager.setTestDialog(TestDialog.OK, testRootDisposable)
            undo.undo(null)
            assertEquals(path.toString(), configuration.sourcePath)
            assertEquals("My query", configuration.name)
            assertFalse(configuration.isGeneratedName)
            undo.redo(null)
            assertEquals(movedPath, configuration.sourcePath)
            assertEquals("My query", configuration.name)
        } finally {
            manager.removeConfiguration(settings)
        }
    }
}
