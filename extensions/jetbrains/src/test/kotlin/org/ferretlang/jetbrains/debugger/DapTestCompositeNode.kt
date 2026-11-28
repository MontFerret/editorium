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
    val more = Channel<Pair<Int, Runnable>>(Channel.UNLIMITED)
    val batches = mutableListOf<Pair<List<String>, Boolean>>()
    var retry: XDebuggerTreeNodeHyperlink? = null
    var sorted = false
    @Volatile var obsolete = false
    override fun isObsolete(): Boolean = obsolete
    override fun addChildren(children: XValueChildrenList, last: Boolean) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        batches.add((0 until children.size()).map(children::getName) to last)
        this.children.trySend(children)
    }
    override fun setErrorMessage(message: String) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        errors.trySend(message)
    }
    override fun setErrorMessage(message: String, link: XDebuggerTreeNodeHyperlink?) {
        retry = link
        setErrorMessage(message)
    }
    @Deprecated("Required legacy abstract callback")
    override fun tooManyChildren(remaining: Int) { error("Expected a presentation-owned load-more callback") }
    override fun tooManyChildren(remaining: Int, addNextChildren: Runnable) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        more.trySend(remaining to addNextChildren)
    }
    override fun setAlreadySorted(alreadySorted: Boolean) { sorted = alreadySorted }
    override fun setMessage(message: String, icon: Icon?, attributes: SimpleTextAttributes, link: XDebuggerTreeNodeHyperlink?) = Unit
}
