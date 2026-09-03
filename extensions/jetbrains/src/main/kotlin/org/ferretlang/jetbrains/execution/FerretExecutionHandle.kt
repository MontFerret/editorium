package org.ferretlang.jetbrains.execution

import kotlinx.coroutines.CompletableDeferred

internal class FerretExecutionHandle {
    val cancellation = CompletableDeferred<Unit>()
    private val lock = Any()
    private var cancellationRequested = false
    private var cancelRpcSent = false
    private var exitCode: Int? = null

    fun cancel(): Boolean = synchronized(lock) {
        if (exitCode != null || cancellationRequested) {
            false
        } else {
            cancellationRequested = true
            cancellation.complete(Unit)
            true
        }
    }

    fun isCancellationRequested(): Boolean = synchronized(lock) { cancellationRequested }

    fun claimCancelRpc(): Boolean = synchronized(lock) {
        if (!cancellationRequested || cancelRpcSent || exitCode != null) {
            false
        } else {
            cancelRpcSent = true
            true
        }
    }

    fun commit(normalExitCode: Int): Int = synchronized(lock) {
        exitCode ?: (if (cancellationRequested) CANCELLED_EXIT_CODE else normalExitCode).also { exitCode = it }
    }

    companion object {
        const val CANCELLED_EXIT_CODE = 130
    }
}
