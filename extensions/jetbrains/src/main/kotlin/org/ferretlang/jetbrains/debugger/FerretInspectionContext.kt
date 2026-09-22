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

/** Presentation lifetime for one stop. All handle validity remains owned by the DAP session. */
internal class FerretInspectionContext(
    val dap: FerretDapSession,
    val stop: FerretDapStop,
    private val scope: CoroutineScope,
    private val project: Project,
) {
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

    fun variables(node: XCompositeNode, reference: Int, bindings: Boolean = false) = children(node) {
        dap.variables(stop, reference)?.let { response ->
            XValueChildrenList(response.variables.size).apply {
                response.variables.forEach { variable ->
                    add(variable.name, FerretValue(
                        this@FerretInspectionContext, variable.value, variable.type, variable.variablesReference,
                        if (bindings) variable.evaluateName?.takeIf(String::isNotBlank) else null,
                    ))
                }
            }
        }
    }
}
