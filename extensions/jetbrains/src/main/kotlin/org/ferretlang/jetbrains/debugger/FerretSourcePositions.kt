package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.readAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.xdebugger.XDebuggerUtil
import com.intellij.xdebugger.XSourcePosition
import org.eclipse.lsp4j.debug.Source
import java.nio.file.Files
import java.nio.file.Path

/** Standard DAP UTF-16 positions; no native Ferret byte-offset conversion belongs here. */
internal class FerretSourcePositions(private val workspace: Path) {
    suspend fun position(source: Source?, line: Int, column: Int): XSourcePosition? {
        if (source == null || line < 1 || column < 1) return null
        val value = source.path?.takeIf(String::isNotBlank) ?: return null
        val file = try {
            val path = Path.of(value)
            val canonical = (if (path.isAbsolute) path else workspace.resolve(path)).toRealPath()
            if (!Files.isRegularFile(canonical)) return null
            LocalFileSystem.getInstance().refreshAndFindFileByNioFile(canonical) ?: return null
        } catch (_: Exception) {
            return null
        }
        return readAction {
            val document = FileDocumentManager.getInstance().getDocument(file) ?: return@readAction null
            val editorLine = line - 1
            val editorColumn = column - 1
            if (editorLine >= document.lineCount) return@readAction null
            val length = document.getLineEndOffset(editorLine) - document.getLineStartOffset(editorLine)
            if (editorColumn > length) return@readAction null
            XDebuggerUtil.getInstance().createPosition(file, editorLine, editorColumn)
        }
    }

    companion object {
        fun dapLine(editorLine: Int): Int = Math.addExact(editorLine, 1)
    }
}
