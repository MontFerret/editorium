package org.ferretlang.jetbrains.execution

import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.Key
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class FerretExecutionProcessHandler : ProcessHandler(), FerretExecutionSink {
    private val cancellation = AtomicReference<FerretExecutionHandle?>()
    private val cancellationRequested = AtomicBoolean()
    private val terminated = AtomicBoolean()

    fun attach(handle: FerretExecutionHandle) {
        if (!cancellation.compareAndSet(null, handle)) {
            error("A Ferret execution handle is already attached.")
        }
        if (cancellationRequested.get()) {
            handle.cancel()
        }
    }

    override fun destroyProcessImpl() = cancelRun()

    override fun detachProcessImpl() = cancelRun()

    override fun detachIsDefault(): Boolean = false

    override fun getProcessInput(): OutputStream? = null

    override fun system(message: String) = write(message, ProcessOutputTypes.SYSTEM)

    override fun stdout(message: String) = write(message, ProcessOutputTypes.STDOUT)

    override fun stderr(message: String) = write(message, ProcessOutputTypes.STDERR)

    override fun internal(message: String, cause: Throwable?) {
        if (cause == null) {
            LOG.warn(message)
        } else {
            LOG.warn(message, cause)
        }
    }

    override fun terminate(exitCode: Int) {
        if (terminated.compareAndSet(false, true)) {
            notifyProcessTerminated(exitCode)
        }
    }

    private fun cancelRun() {
        if (cancellationRequested.compareAndSet(false, true)) {
            system("Cancelling Ferret execution...")
        }
        cancellation.get()?.cancel()
    }

    private fun write(message: String, outputType: Key<*>) {
        val text = if (message.endsWith('\n')) message else "$message\n"
        notifyTextAvailable(text, outputType)
    }

    companion object {
        private val LOG = Logger.getInstance(FerretExecutionProcessHandler::class.java)
    }
}
