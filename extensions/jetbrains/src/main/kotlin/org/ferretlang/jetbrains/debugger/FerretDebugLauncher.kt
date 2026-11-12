package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.components.Service
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import java.nio.file.Path

/** Project lifetime only; every caller owns its independent launch scope. */
@Service(Service.Level.PROJECT)
internal class FerretDebugLauncher private constructor(
    private val coroutineScope: CoroutineScope,
    val createSession: (FerretLaunchInput, FerretDapListener) -> FerretDapSession,
) {
    constructor(coroutineScope: CoroutineScope) : this(coroutineScope, ::FerretDapSession)

    fun newLaunchScope(): CoroutineScope = CoroutineScope(
        coroutineScope.coroutineContext + SupervisorJob(coroutineScope.coroutineContext[Job]),
    )

    companion object {
        internal fun testing(scope: CoroutineScope, executable: Path): FerretDebugLauncher =
            FerretDebugLauncher(scope) { input, listener -> FerretDapSession(input, listener, { executable }) }

        internal fun testing(scope: CoroutineScope, session: (FerretLaunchInput, FerretDapListener) -> FerretDapSession) =
            FerretDebugLauncher(scope, session)
    }
}
