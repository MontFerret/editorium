package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator
import com.intellij.xdebugger.frame.XValue
import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.atomic.AtomicInteger

internal class DapTestEvaluationCallback : XDebuggerEvaluator.XEvaluationCallback {
    val result = CompletableDeferred<Result<XValue>>()
    val calls = AtomicInteger()
    var invalidExpression = false
        private set

    override fun evaluated(value: XValue) = complete(Result.success(value))
    override fun errorOccurred(message: String) = complete(Result.failure(IllegalStateException(message)))
    override fun invalidExpression(message: String) {
        invalidExpression = true
        errorOccurred(message)
    }

    private fun complete(value: Result<XValue>) {
        ApplicationManager.getApplication().assertIsDispatchThread()
        check(calls.incrementAndGet() == 1) { "Evaluation callback completed more than once" }
        result.complete(value)
    }
}
