package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.xdebugger.frame.XFullValueEvaluator
import com.intellij.xdebugger.frame.XValueNode
import com.intellij.xdebugger.frame.presentation.XValuePresentation
import kotlinx.coroutines.CompletableDeferred
import javax.swing.Icon

internal class DapTestValueNode : XValueNode {
    val presentation = CompletableDeferred<Presentation>()
    @Volatile var obsolete = false
    override fun isObsolete(): Boolean = obsolete
    override fun setPresentation(icon: Icon?, type: String?, value: String, hasChildren: Boolean) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        presentation.complete(Presentation(type, value, hasChildren))
    }
    override fun setPresentation(icon: Icon?, presentation: XValuePresentation, hasChildren: Boolean) {
        error("Use the canonical DAP type and display")
    }
    override fun setFullValueEvaluator(evaluator: XFullValueEvaluator) { error("No client-side full-value evaluation") }

    data class Presentation(val type: String?, val value: String, val expandable: Boolean)
}
