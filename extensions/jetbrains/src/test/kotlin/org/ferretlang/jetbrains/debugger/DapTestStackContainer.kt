package org.ferretlang.jetbrains.debugger

import com.intellij.xdebugger.frame.XExecutionStack
import com.intellij.xdebugger.frame.XStackFrame
import kotlinx.coroutines.channels.Channel

internal class DapTestStackContainer : XExecutionStack.XStackFrameContainer {
    val pages = Channel<Pair<List<XStackFrame>, Boolean>>(Channel.UNLIMITED)
    val errors = Channel<String>(Channel.UNLIMITED)
    @Volatile var obsolete = false
    override fun isObsolete(): Boolean = obsolete
    override fun addStackFrames(stackFrames: List<XStackFrame>, last: Boolean) { pages.trySend(stackFrames to last) }
    override fun errorOccurred(errorMessage: String) { errors.trySend(errorMessage) }
}
