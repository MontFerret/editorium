package org.ferretlang.jetbrains.debugger

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindings
import java.nio.file.Files

internal class DapTestLaunch(
    timeouts: FerretDapTimeouts = FerretDapTimeouts(3_000, 2_000, 100),
    requiresForce: Boolean = false,
    beforeProcess: () -> Unit = {},
    bindings: FerretParameterBindings = FerretParameterBindings.EMPTY,
) {
    val root = Files.createTempDirectory("ferret-dap-test-")
    val source = Files.writeString(root.resolve("query.fql"), "RETURN 1")
    val input = FerretLaunchInput(source.toString(), "", root.toString(), bindings)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val adapter = DapTestAdapter()
    val process = DapTestProcess(adapter, requiresForce)
    val listener = DapTestListener()
    val session = FerretDapSession(input, listener, { source }, { beforeProcess(); process }, timeouts)

    fun start() = scope.launch { session.run() }

    suspend fun close() {
        session.stop()
        session.completion.await()
        scope.cancel()
        process.close()
        Files.deleteIfExists(source)
        Files.deleteIfExists(root)
    }
}
