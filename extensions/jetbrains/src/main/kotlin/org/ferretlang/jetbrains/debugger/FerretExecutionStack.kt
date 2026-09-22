package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.frame.XExecutionStack
import com.intellij.xdebugger.frame.XStackFrame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.eclipse.lsp4j.debug.StackFrame

internal class FerretExecutionStack(
    private val dap: FerretDapSession,
    val stop: FerretDapStop,
    private val scope: CoroutineScope,
    private val positions: FerretSourcePositions,
    private val project: Project,
) : XExecutionStack("Ferret") {
    private val inspection = FerretInspectionContext(dap, stop, scope, project)
    private var top: FerretStackFrame? = null

    override fun getTopFrame(): XStackFrame? = top

    suspend fun loadTopFrame() {
        val response = dap.stackTrace(stop, 0, 1) ?: return
        val frame = response.stackFrames.firstOrNull()?.let { frame(it) }
        withContext(Dispatchers.EDT) { if (inspection.isCurrent()) top = frame }
    }

    override fun computeStackFrames(firstFrameIndex: Int, container: XStackFrameContainer) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                withContext(Dispatchers.IO) {
                    var offset = firstFrameIndex
                    while (!container.isObsolete && inspection.isCurrent()) {
                        val response = dap.stackTrace(stop, offset, PAGE_SIZE) ?: break
                        val frames = response.stackFrames.map { frame(it) }
                        offset += frames.size
                        val last = frames.isEmpty() || (response.totalFrames?.let { offset >= it } ?: (frames.size < PAGE_SIZE))
                        withContext(Dispatchers.EDT) {
                            if (!container.isObsolete && inspection.isCurrent()) container.addStackFrames(frames, last)
                        }
                        if (last) break
                    }
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                withContext(Dispatchers.EDT) {
                    if (!container.isObsolete && inspection.isCurrent()) {
                        container.errorOccurred(FerretDapErrors.message(error, "Cannot load the Ferret stack."))
                    }
                }
            } finally {
                withContext(NonCancellable + Dispatchers.EDT) {
                    if (!container.isObsolete && !project.isDisposed && !inspection.isCurrent()) {
                        container.addStackFrames(emptyList(), true)
                    }
                }
            }
        }
    }

    private suspend fun frame(frame: StackFrame): FerretStackFrame = FerretStackFrame(
        frame.id, frame.name, inspection, positions.position(frame.source, frame.line, frame.column),
    )

    companion object {
        private const val PAGE_SIZE = 100
    }
}
