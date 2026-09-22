package org.ferretlang.jetbrains.debugger

import org.eclipse.lsp4j.debug.Breakpoint
import java.nio.file.Path

internal data class FerretDapBreakpoint(val key: Long, val line: Int)

internal data class FerretDapBreakpoints(
    val source: Path,
    val revision: Long,
    val entries: List<FerretDapBreakpoint>,
)

internal data class FerretDapStop(
    val generation: Long,
    val threadId: Int,
    val reason: String,
    val description: String?,
    val hitKeys: List<Long>,
)

internal data class FerretDapTimeouts(
    val startupMillis: Long = 30_000,
    val requestMillis: Long = 10_000,
    val shutdownMillis: Long = 5_000,
)

internal enum class FerretDapCommand { CONTINUE, PAUSE, NEXT, STEP_IN, STEP_OUT }

/** Presentation callbacks. The implementation owns dispatch to the IDE's UI thread. */
internal interface FerretDapListener {
    suspend fun initializeBreakpoints()
    fun breakpoints(batch: FerretDapBreakpoints, results: List<Breakpoint>, error: String?)
    fun stopped(stop: FerretDapStop)
    fun resumed(generation: Long)
    fun output(text: String, error: Boolean)
    fun error(message: String)
    suspend fun terminated(exitCode: Int)
}
