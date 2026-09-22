package org.ferretlang.jetbrains.debugger

import com.intellij.ui.ColoredTextContainer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.xdebugger.XSourcePosition
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XStackFrame
import com.intellij.xdebugger.frame.XValueChildrenList

internal class FerretStackFrame(
    val frameId: Int,
    val name: String,
    private val inspection: FerretInspectionContext,
    private val position: XSourcePosition?,
) : XStackFrame() {
    val stop: FerretDapStop get() = inspection.stop
    private val evaluator = FerretDebuggerEvaluator(inspection, frameId)

    override fun getEqualityObject(): Any = Triple(inspection.dap, stop.generation, frameId)

    override fun getEvaluator(): XDebuggerEvaluator = evaluator

    override fun getSourcePosition(): XSourcePosition? = position

    override fun customizePresentation(component: ColoredTextContainer) {
        component.append(name, SimpleTextAttributes.REGULAR_ATTRIBUTES)
        position?.let { component.append(" (${it.file.name}:${it.line + 1})", SimpleTextAttributes.GRAY_ATTRIBUTES) }
    }

    override fun computeChildren(node: XCompositeNode) = inspection.children(node) {
        inspection.dap.scopes(stop, frameId)?.let { response ->
            XValueChildrenList().apply {
                response.scopes.forEach { addTopGroup(FerretScopeGroup(it.name, it.variablesReference, inspection)) }
            }
        }
    }
}
