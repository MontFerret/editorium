package org.ferretlang.jetbrains.run

import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFileSystemItem
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.refactoring.listeners.RefactoringElementListener
import java.nio.file.Path

internal class FerretRunSourceRefactoringListener(
    private val configuration: FerretRunConfiguration,
    private val suffix: Path,
) : RefactoringElementListener {

    override fun elementMoved(newElement: PsiElement) = update(newElement)

    override fun elementRenamed(newElement: PsiElement) = update(newElement)

    private fun update(element: PsiElement) {
        val file = (element as? PsiFileSystemItem)?.virtualFile ?: return
        val source = file.toNioPath().toAbsolutePath().normalize().resolve(suffix).normalize()
        val base = configuration.project.basePath?.let(Path::of)
        val before = state()
        val relative = !Path.of(before.source).isAbsolute
        configuration.sourcePath = if (relative && base != null) base.relativize(source).toString() else source.toString()
        if (before.generatedName) configuration.setGeneratedName()
        // Refactoring callbacks do not cover native move undo or rename redo.
        // Record these fields in the refactoring's own JetBrains undo command.
        UndoManager.getInstance(configuration.project).undoableActionPerformed(
            FerretRunSourceUndoableAction(configuration, before, state()),
        )
    }

    private fun state() = FerretRunSourceState(configuration.sourcePath, configuration.name, configuration.isGeneratedName)
}
