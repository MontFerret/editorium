package org.ferretlang.jetbrains.debugger

import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.ui.ExecutionConsole
import com.intellij.openapi.application.EDT
import com.intellij.openapi.components.service
import com.intellij.xdebugger.XDebugProcess
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.breakpoints.XBreakpointHandler
import com.intellij.xdebugger.evaluation.XDebuggerEditorsProvider
import com.intellij.xdebugger.frame.XSuspendContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.eclipse.lsp4j.debug.Breakpoint
import org.ferretlang.jetbrains.launch.FerretLaunchInput

internal class FerretDebugProcess(session: XDebugSession, input: FerretLaunchInput) : XDebugProcess(session), FerretDapListener {
    private val launcher = session.project.service<FerretDebugLauncher>()
    private val scope = launcher.newLaunchScope()
    internal val dap = launcher.session(input, this)
    private val handler = FerretDebugProcessHandler(dap::stop)
    private val console = TextConsoleBuilderFactory.getInstance().createBuilder(session.project).console.apply {
        attachToProcess(handler)
    }
    private val breakpoints = FerretBreakpointHandler(session, dap)
    private val editors = FerretDebuggerEditorsProvider()

    override fun sessionInitialized() {
        // Enter the ownership/finally boundary even if project cancellation already won.
        scope.launch(start = CoroutineStart.UNDISPATCHED) { dap.run() }
    }

    override fun doGetProcessHandler(): ProcessHandler = handler
    override fun createConsole(): ExecutionConsole = console
    override fun getEditorsProvider(): XDebuggerEditorsProvider = editors
    override fun getBreakpointHandlers(): Array<XBreakpointHandler<*>> = arrayOf(breakpoints)
    override fun checkCanInitBreakpoints(): Boolean = false
    override fun checkCanPerformCommands(): Boolean = dap.canPerformCommands()
    override fun resume(context: XSuspendContext?) = control(FerretDapCommand.CONTINUE, context)
    override fun startStepOver(context: XSuspendContext?) = control(FerretDapCommand.NEXT, context)
    override fun startStepInto(context: XSuspendContext?) = control(FerretDapCommand.STEP_IN, context)
    override fun startStepOut(context: XSuspendContext?) = control(FerretDapCommand.STEP_OUT, context)
    override fun startPausing() { dap.command(FerretDapCommand.PAUSE) }
    override fun stop() = dap.stop()

    override suspend fun initializeBreakpoints() = withContext(Dispatchers.EDT) {
        if (!session.project.isDisposed && !handler.isProcessTerminated) breakpoints.initialize()
    }

    override fun breakpoints(batch: FerretDapBreakpoints, results: List<Breakpoint>, error: String?) {
        scope.launch(Dispatchers.EDT) {
            if (!session.project.isDisposed && !handler.isProcessTerminated) breakpoints.present(batch, results, error)
        }
    }

    override fun stopped(stop: FerretDapStop) {
        scope.launch(Dispatchers.IO) {
            val workspace = dap.resolvedInput?.workspaceRoot ?: return@launch
            val stack = FerretExecutionStack(dap, stop, scope, FerretSourcePositions(workspace), session.project)
            val stackError = try {
                stack.loadTopFrame()
                null
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                FerretDapErrors.message(error, "Cannot load the Ferret stack.")
            }
            withContext(Dispatchers.EDT) {
                if (!dap.isCurrentStop(stop) || session.project.isDisposed || handler.isProcessTerminated) return@withContext
                stackError?.let(this@FerretDebugProcess::error)
                val context = FerretSuspendContext(stack)
                val breakpoint = breakpoints.hit(stop.hitKeys)
                if (stop.reason != "breakpoint" || breakpoint == null || !session.breakpointReached(breakpoint, null, context)) {
                    // A committed adapter stop is authoritative even after removal/muting in the IDE.
                    session.positionReached(context)
                }
                if (stop.reason == "exception") session.reportError(stop.description ?: "Ferret execution stopped on an exception.")
            }
        }
    }

    override fun resumed(generation: Long) {
        scope.launch(Dispatchers.EDT) {
            if (dap.isRunningAfter(generation) && !session.project.isDisposed) session.sessionResumed()
        }
    }

    override fun output(text: String, error: Boolean) = handler.output(text, error)

    override fun error(message: String) {
        handler.output("$message\n", true)
    }

    override suspend fun terminated(exitCode: Int) = withContext(Dispatchers.EDT) {
        handler.complete(exitCode)
        scope.cancel()
    }

    private fun control(command: FerretDapCommand, context: XSuspendContext?) {
        dap.command(command, (context as? FerretSuspendContext)?.stack?.stop)
    }
}
