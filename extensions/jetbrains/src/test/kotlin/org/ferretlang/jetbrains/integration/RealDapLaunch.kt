package org.ferretlang.jetbrains.integration

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import org.ferretlang.jetbrains.debugger.FerretDapStop
import org.ferretlang.jetbrains.debugger.DapTestListener
import org.ferretlang.jetbrains.debugger.FerretDapBreakpoint
import org.ferretlang.jetbrains.debugger.FerretDapBreakpoints
import org.ferretlang.jetbrains.debugger.FerretDapSession
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import java.nio.file.Path

internal class RealDapLaunch(val input: FerretLaunchInput, scope: CoroutineScope, vararg lines: Int) {
    val listener = DapTestListener()
    lateinit var process: Process
        private set
    val session = FerretDapSession(input, listener, { Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH"))) }, { binary ->
        ProcessBuilder(binary.toString(), "dap").start().also { process = it }
    })

    init {
        listener.initialize = { if (lines.isNotEmpty()) replace(1, *lines) }
        scope.launch { session.run() }
    }

    fun replace(revision: Long, vararg lines: Int) {
        session.replaceBreakpoints(FerretDapBreakpoints(Path.of(input.sourcePath), revision, lines.map {
            FerretDapBreakpoint(it.toLong(), it)
        }))
    }

    suspend fun stopped(): FerretDapStop = select {
        listener.stops.onReceive { it }
        session.completion.onAwait { error("Debug exited $it before stopping: ${listener.errors.tryReceive().getOrNull()}; ${listener.output.tryReceive().getOrNull()}") }
    }

}
