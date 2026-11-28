package org.ferretlang.jetbrains.debugger

import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XValueGroup

internal class FerretScopeGroup(
    name: String,
    private val reference: Int,
    private val inspection: FerretInspectionContext,
    private val named: Int?,
    private val indexed: Int?,
) : XValueGroup(name) {
    override fun isRestoreExpansion(): Boolean = true

    override fun computeChildren(node: XCompositeNode) =
        inspection.variables(node, reference, named, indexed)
}
