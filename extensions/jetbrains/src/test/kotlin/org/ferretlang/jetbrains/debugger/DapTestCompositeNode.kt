package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.SimpleTextAttributes
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink
import com.intellij.xdebugger.frame.XValueChildrenList
import kotlinx.coroutines.channels.Channel
import javax.swing.Icon

internal class DapTestCompositeNode : XCompositeNode {
    val children = Channel<XValueChildrenList>(Channel.UNLIMITED)
    val errors = Channel<String>(Channel.UNLIMITED)
    @Volatile var obsolete = false
    override fun isObsolete(): Boolean = obsolete
    override fun addChildren(children: XValueChildrenList, last: Boolean) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        check(last)
        this.children.trySend(children)
    }
    override fun setErrorMessage(message: String) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        errors.trySend(message)
    }
    override fun setErrorMessage(message: String, link: XDebuggerTreeNodeHyperlink?) = setErrorMessage(message)
    @Deprecated("Required legacy abstract callback")
    override fun tooManyChildren(remaining: Int) { error("Variable paging must not be invented") }
    override fun setAlreadySorted(alreadySorted: Boolean) = Unit
    override fun setMessage(message: String, icon: Icon?, attributes: SimpleTextAttributes, link: XDebuggerTreeNodeHyperlink?) = Unit
}
