package org.ferretlang.jetbrains.debugger

import com.intellij.psi.PsiFile
import com.intellij.xdebugger.XExpression
import com.intellij.xdebugger.XSourcePosition
import com.intellij.xdebugger.evaluation.EvaluationMode
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator

internal class FerretDebuggerEvaluator(
    private val inspection: FerretInspectionContext,
    private val frameId: Int,
) : XDebuggerEvaluator() {
    override fun isCodeFragmentEvaluationSupported(): Boolean = false

    override fun getEvaluationMode(text: String, startOffset: Int, endOffset: Int, psiFile: PsiFile?): EvaluationMode =
        EvaluationMode.EXPRESSION

    override fun evaluate(expression: XExpression, callback: XEvaluationCallback, expressionPosition: XSourcePosition?) {
        if (expression.mode == EvaluationMode.CODE_FRAGMENT) {
            inspection.request({ Unit }) { result ->
                callback.invalidExpression(if (result.getOrNull() == null) {
                    "Evaluation is no longer available for this stop."
                } else "Ferret Debug supports expressions only.")
            }
        } else evaluate(expression.expression, callback, expressionPosition)
    }

    override fun evaluate(expression: String, callback: XEvaluationCallback, expressionPosition: XSourcePosition?) {
        inspection.request({ inspection.dap.evaluate(inspection.stop, frameId, expression) }) { result ->
            result.fold({ value ->
                if (value == null) {
                    callback.invalidExpression("Evaluation is no longer available for this stop.")
                } else {
                    callback.evaluated(FerretValue(inspection, value.result, value.type, value.variablesReference, expression))
                }
            }, { callback.invalidExpression(FerretDapErrors.message(it, "Cannot evaluate this Ferret expression.")) })
        }
    }
}
