package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.XNamedTreeNode
import com.intellij.xdebugger.XSourcePosition
import com.intellij.xdebugger.XExpression
import com.intellij.xdebugger.evaluation.EvaluationMode
import com.intellij.xdebugger.evaluation.InlineDebuggerHelper
import com.intellij.xdebugger.evaluation.XDebuggerEditorsProvider
import org.ferretlang.jetbrains.lang.FerretLanguageFileType

internal class FerretDebuggerEditorsProvider : XDebuggerEditorsProvider() {
    override fun getFileType(): FileType = FerretLanguageFileType

    // Ferret objects can have a member named "this". Inspect it only on explicit expansion.
    override fun getInlineDebuggerHelper(): InlineDebuggerHelper = inlineHelper

    private val inlineHelper = object : InlineDebuggerHelper() {
        override fun shouldEvaluateChildrenByDefault(node: XNamedTreeNode): Boolean = false
    }

    override fun createDocument(
        project: Project, expression: XExpression, sourcePosition: XSourcePosition?, mode: EvaluationMode, purpose: String?,
    ): Document = EditorFactory.getInstance().createDocument(expression.expression)
}
