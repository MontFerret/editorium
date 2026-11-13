package org.ferretlang.jetbrains.integration

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.execution.FerretExecutionSink
import java.util.Collections

internal class RecordingExecution : FerretExecutionSink {
    val started = CompletableDeferred<Unit>()
    val events = Collections.synchronizedList(mutableListOf<String>())
    val debug = Collections.synchronizedList(mutableListOf<String>())
    val system = Collections.synchronizedList(mutableListOf<String>())
    val stdout = Collections.synchronizedList(mutableListOf<String>())
    val stderr = Collections.synchronizedList(mutableListOf<String>())
    val internal = Collections.synchronizedList(mutableListOf<String>())
    val exit = CompletableDeferred<Int>()
    lateinit var handle: org.ferretlang.jetbrains.execution.FerretExecutionHandle

    override fun started() { started.complete(Unit) }

    override fun debug(message: String) { debug += message }

    override fun system(message: String) {
        system += message
    }

    override fun stdout(message: String) {
        stdout += message
        events += "output"
    }

    override fun stderr(message: String) {
        stderr += message
    }

    override fun internal(message: String, cause: Throwable?) {
        internal += "$message: ${cause?.javaClass?.name}: ${cause?.message}"
    }

    override fun terminate(exitCode: Int) {
        events += "terminated:$exitCode"
        internal += "terminated=$exitCode"
        exit.complete(exitCode)
    }

    suspend fun awaitStarted() {
        withTimeout(15_000L) { started.await() }
    }

    fun debug(): String = "system=$system stdout=$stdout stderr=$stderr internal=$internal"
}

