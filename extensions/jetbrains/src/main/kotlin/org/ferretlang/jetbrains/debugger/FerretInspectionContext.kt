package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XValueChildrenList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Presentation lifetime for one stop. All handle validity remains owned by the DAP session. */
internal class FerretInspectionContext(
    val dap: FerretDapSession,
    val stop: FerretDapStop,
    private val scope: CoroutineScope,
    private val project: Project,
) {
    // XDebugger may refresh the same node in place. Weak keys retain no editor nodes or pages.
    private val presentations = WeakHashMap<XCompositeNode, AtomicBoolean>()

    fun isCurrent(): Boolean = !project.isDisposed && dap.isCurrentStop(stop)

    fun <T> request(operation: suspend () -> T?, completed: (Result<T?>) -> Unit) {
        // Enter finalization even when the launch scope was cancelled before the IDE callback arrived.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var result: Result<T?> = Result.success(null)
            try {
                result = Result.success(withContext(Dispatchers.IO) { if (isCurrent()) operation() else null })
            } catch (_: CancellationException) {
                // Obsolescence is not a debugger failure.
            } catch (error: Exception) {
                result = Result.failure(error)
            } finally {
                withContext(NonCancellable + Dispatchers.EDT) {
                    completed(if (isCurrent()) result else Result.success(null))
                }
            }
        }
    }

    fun children(node: XCompositeNode, operation: suspend () -> XValueChildrenList?) {
        if (node.isObsolete || project.isDisposed) return
        request({ if (node.isObsolete) null else operation() }) { result ->
            if (!node.isObsolete && !project.isDisposed) {
                result.fold(
                    { node.addChildren(it ?: XValueChildrenList.EMPTY, true) },
                    { node.setErrorMessage(FerretDapErrors.message(it, "Cannot load Ferret values.")) },
                )
            }
        }
    }

    fun variables(node: XCompositeNode, reference: Int, named: Int?, indexed: Int?) {
        if (node.isObsolete || !isCurrent()) return
        val active = AtomicBoolean(true)
        synchronized(presentations) { presentations.put(node, active)?.set(false) }
        FerretVariablePages(this, node, active, reference, named, indexed).start()
    }
}
