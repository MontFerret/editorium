package org.ferretlang.jetbrains.debugger

import com.intellij.ui.ColoredTextContainer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.xdebugger.XSourcePosition
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XStackFrame
import com.intellij.xdebugger.frame.XValueChildrenList

internal class FerretStackFrame(
    val frameId: Int,
    val name: String,
    val stop: FerretDapStop,
    private val position: XSourcePosition?,
) : XStackFrame() {
    override fun getEqualityObject(): Any = stop.generation to frameId

    override fun getSourcePosition(): XSourcePosition? = position

    override fun customizePresentation(component: ColoredTextContainer) {
        component.append(name, SimpleTextAttributes.REGULAR_ATTRIBUTES)
        position?.let { component.append(" (${it.file.name}:${it.line + 1})", SimpleTextAttributes.GRAY_ATTRIBUTES) }
    }

    override fun computeChildren(node: XCompositeNode) {
        node.addChildren(XValueChildrenList.EMPTY, true)
    }
}
