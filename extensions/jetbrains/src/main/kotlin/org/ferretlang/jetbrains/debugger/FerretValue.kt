package org.ferretlang.jetbrains.debugger

import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValueNode
import com.intellij.xdebugger.frame.XValuePlace

internal class FerretValue(
    private val inspection: FerretInspectionContext,
    private val display: String,
    private val type: String?,
    private val reference: Int,
    private val expression: String? = null,
) : XValue() {
    override fun computePresentation(node: XValueNode, place: XValuePlace) {
        if (!node.isObsolete && inspection.isCurrent()) node.setPresentation(null, type, display, reference > 0)
    }

    override fun computeChildren(node: XCompositeNode) = inspection.variables(node, reference)

    override fun getEvaluationExpression(): String? = expression.takeIf { inspection.isCurrent() }
}
