package org.ferretlang.jetbrains.debugger

import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessOutputTypes
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean

internal class FerretDebugProcessHandler(private val stopSession: () -> Unit) : ProcessHandler() {
    private val completed = AtomicBoolean()

    override fun destroyProcessImpl() = stopSession()
    override fun detachProcessImpl() = stopSession()
    override fun detachIsDefault(): Boolean = false
    override fun getProcessInput(): OutputStream? = null

    fun output(text: String, error: Boolean) {
        notifyTextAvailable(text, if (error) ProcessOutputTypes.STDERR else ProcessOutputTypes.STDOUT)
    }

    fun complete(exitCode: Int) {
        if (completed.compareAndSet(false, true)) notifyProcessTerminated(exitCode)
    }
}
