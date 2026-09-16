package org.ferretlang.jetbrains.debugger

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import org.eclipse.lsp4j.debug.Breakpoint

internal class DapTestListener : FerretDapListener {
    var initialize: suspend () -> Unit = {}
    val stops = Channel<FerretDapStop>(Channel.UNLIMITED)
    val resumed = Channel<Long>(Channel.UNLIMITED)
    val replacements = Channel<Triple<FerretDapBreakpoints, List<Breakpoint>, String?>>(Channel.UNLIMITED)
    val errors = Channel<String>(Channel.UNLIMITED)
    val output = Channel<Pair<String, Boolean>>(Channel.UNLIMITED)
    val terminated = CompletableDeferred<Int>()

    override suspend fun initializeBreakpoints() = initialize()
    override fun stopped(stop: FerretDapStop) { stops.trySend(stop) }
    override fun resumed(generation: Long) { resumed.trySend(generation) }
    override fun breakpoints(batch: FerretDapBreakpoints, results: List<Breakpoint>, error: String?) {
        replacements.trySend(Triple(batch, results, error))
    }
    override fun output(text: String, error: Boolean) { output.trySend(text to error) }
    override fun error(message: String) { errors.trySend(message) }
    override suspend fun terminated(exitCode: Int) { terminated.complete(exitCode) }
}
