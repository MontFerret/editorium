package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.components.Service
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import org.ferretlang.jetbrains.daemon.FerretdBinary
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import java.nio.file.Path

/** Project lifetime only; every caller owns its independent launch scope. */
@Service(Service.Level.PROJECT)
internal class FerretDebugLauncher private constructor(
    private val coroutineScope: CoroutineScope,
    private val executable: () -> Path,
) {
    constructor(coroutineScope: CoroutineScope) : this(coroutineScope, { FerretdBinary.installed().resolve() })

    fun newLaunchScope(): CoroutineScope = CoroutineScope(
        coroutineScope.coroutineContext + SupervisorJob(coroutineScope.coroutineContext[Job]),
    )

    fun session(input: FerretLaunchInput, listener: FerretDapListener): FerretDapSession =
        FerretDapSession(input, listener, executable)

    companion object {
        internal fun testing(scope: CoroutineScope, executable: Path): FerretDebugLauncher =
            FerretDebugLauncher(scope, { executable })
    }
}
