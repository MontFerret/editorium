package org.ferretlang.jetbrains.debugger

import com.intellij.util.concurrency.AppExecutorUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import org.eclipse.lsp4j.debug.services.IDebugProtocolClient
import org.eclipse.lsp4j.debug.services.IDebugProtocolServer
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.Future

internal class FerretDapTransport(
    scope: CoroutineScope,
    private val input: InputStream,
    private val output: OutputStream,
    client: IDebugProtocolClient,
    failed: (Throwable) -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean()
    private val executor = AppExecutorUtil.createBoundedApplicationPoolExecutor("Ferret DAP", 2)
    val server: IDebugProtocolServer
    private val listening: Future<Void>
    val reader: Job

    init {
        try {
            val launcher = FerretDapLauncherBuilder { if (!closed.get()) failed(it) }
                .setLocalService(client)
                .setRemoteInterface(IDebugProtocolServer::class.java)
                .setInput(input)
                .setOutput(output)
                .setExecutorService(executor)
                .validateMessages(true)
                .create()
            server = launcher.remoteProxy
            listening = launcher.startListening()
            reader = scope.launch(Dispatchers.IO) {
                try {
                    runInterruptible { listening.get() }
                    if (!closed.get()) failed(IllegalStateException("The Ferret debug adapter closed its DAP stream."))
                } catch (error: Exception) {
                    if (!closed.get() && error !is kotlinx.coroutines.CancellationException) failed(error)
                }
            }
        } catch (error: Exception) {
            closed.set(true)
            runCatching { output.close() }
            runCatching { input.close() }
            executor.shutdownNow()
            throw error
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            output.close()
        } finally {
            try {
                input.close()
            } finally {
                listening.cancel(true)
                reader.cancel()
                executor.shutdownNow()
            }
        }
    }
}
