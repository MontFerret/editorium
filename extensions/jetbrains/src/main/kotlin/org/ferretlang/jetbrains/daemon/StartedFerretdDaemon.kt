package org.ferretlang.jetbrains.daemon

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import org.ferretlang.jetbrains.execution.FerretdRpc
import java.util.concurrent.atomic.AtomicBoolean

internal data class StartedFerretdDaemon(
    val process: Process,
    val rpc: FerretdRpc,
    val lost: CompletableDeferred<Throwable>,
    val stopping: AtomicBoolean,
    val stderr: Job,
    val stdout: Job,
    val processWaiter: Job,
)
