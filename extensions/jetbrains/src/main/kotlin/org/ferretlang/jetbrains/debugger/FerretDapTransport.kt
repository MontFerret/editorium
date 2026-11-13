package org.ferretlang.jetbrains.debugger

import com.google.gson.JsonElement
import com.intellij.util.concurrency.AppExecutorUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import org.eclipse.lsp4j.debug.InitializeRequestArguments
import org.eclipse.lsp4j.debug.services.IDebugProtocolClient
import org.eclipse.lsp4j.debug.services.IDebugProtocolServer
import org.eclipse.lsp4j.jsonrpc.RemoteEndpoint
import org.ferretlang.jetbrains.run.FerretParameterBindings
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

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
    private val endpoint: RemoteEndpoint
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
                .configureGson { it.registerTypeAdapter(FerretParameterBindings::class.java, FerretDapParameterBindingsAdapter()) }
                .validateMessages(true)
                .create()
            endpoint = launcher.remoteEndpoint
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

    fun initialize(arguments: InitializeRequestArguments): CompletableFuture<FerretDapCapabilities> =
        endpoint.request("initialize", arguments).thenApply {
            it as? FerretDapCapabilities ?: error("The Ferret adapter omitted its capabilities.")
        }

    fun launch(arguments: Map<String, Any>, expectedName: String?): CompletableFuture<Unit> =
        endpoint.request("launch", arguments).thenApply { body ->
            if (expectedName != null) {
                val name = (body as? JsonElement)?.takeIf { it.isJsonObject }?.asJsonObject?.get("runtimeName")
                check(name != null && name.isJsonPrimitive && name.asJsonPrimitive.isString && name.asString == expectedName) {
                    "The Ferret adapter did not acknowledge the expected runtime '$expectedName'."
                }
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
