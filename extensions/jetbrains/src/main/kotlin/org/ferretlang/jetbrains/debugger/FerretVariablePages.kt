package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.SimpleTextAttributes
import com.intellij.xdebugger.frame.XCompositeNode
import com.intellij.xdebugger.frame.XDebuggerTreeNodeHyperlink
import com.intellij.xdebugger.frame.XValueChildrenList
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.eclipse.lsp4j.debug.Variable
import org.eclipse.lsp4j.debug.VariablesArgumentsFilter
import java.awt.event.MouseEvent
import java.util.concurrent.atomic.AtomicBoolean

/** One child presentation. Only its EDT callbacks can commit rows or start another page. */
internal class FerretVariablePages(
    private val inspection: FerretInspectionContext,
    private val node: XCompositeNode,
    private val activePresentation: AtomicBoolean,
    private val reference: Int,
    private val named: Int?,
    private val indexed: Int?,
) {
    private var kind = if (named == 0) VariablesArgumentsFilter.INDEXED else VariablesArgumentsFilter.NAMED
    private var offset = 0
    private var revision = 0L
    private var showingError = false
    private val size get() = if (kind == VariablesArgumentsFilter.NAMED) named else indexed
    private val hasNextKind get() = kind == VariablesArgumentsFilter.NAMED && indexed != 0
    private fun current() = activePresentation.get() && !node.isObsolete && inspection.isCurrent()

    fun start() {
        if (!ApplicationManager.getApplication().isDispatchThread) {
            ApplicationManager.getApplication().invokeLater { start() }
            return
        }
        if (!current()) return
        node.setAlreadySorted(true)
        if (reference <= 0 || size == 0) node.addChildren(XValueChildrenList.EMPTY, true)
        else load(revision)
    }

    private fun load(expected: Long, skipKind: Boolean = false) {
        if (!current() || expected != revision) return
        val active = ++revision
        if (skipKind) nextKind()
        if (showingError) {
            node.setMessage("", null, SimpleTextAttributes.REGULAR_ATTRIBUTES, null)
            showingError = false
        }
        val filter = kind
        val start = offset
        val limit = minOf(XCompositeNode.MAX_CHILDREN_TO_SHOW, 1000)
        val count = size?.let { minOf(it - start, limit) } ?: limit
        inspection.request({
            coroutineScope {
                // XCompositeNode exposes obsolescence as a flag, without a disposal listener.
                val watcher = launch {
                    while (current()) delay(100)
                    this@coroutineScope.cancel()
                }
                try {
                    if (!current()) null else inspection.dap.variables(inspection.stop, reference, filter, start, count)
                        ?.variables?.takeIf { current() }?.also {
                            check(it.size <= count) { "The Ferret adapter returned too many children." }
                            check(size == null || it.size == count) { "The Ferret adapter returned an incomplete page." }
                        }
                } finally { watcher.cancel() }
            }
        }) { result ->
            if (current() && revision == active) result.fold(
                { rows -> if (rows != null) publish(rows, count) },
                { error -> failed(error) },
            )
        }
    }

    private fun publish(rows: Array<Variable>, count: Int) {
        val children = XValueChildrenList(rows.size)
        for (row in rows) children.add(row.name, FerretValue(
            inspection, row.value, row.type, row.variablesReference, row.evaluateName?.takeIf(String::isNotBlank),
            row.namedVariables, row.indexedVariables,
        ))
        val end = Math.addExact(offset, rows.size)
        val exhausted = end == size || rows.size < count
        val last = exhausted && !hasNextKind
        if (!current()) return
        node.addChildren(children, last)
        offset = end
        if (last || !current()) return
        if (exhausted) nextKind()
        val remaining = size?.let { total ->
            val sibling = if (hasNextKind) indexed else 0
            sibling?.let { total.toLong() - offset + it }
        }
        val expected = revision
        node.tooManyChildren(remaining?.takeIf { it <= Int.MAX_VALUE }?.toInt() ?: -1) { load(expected) }
    }

    private fun failed(error: Throwable) {
        val expected = revision
        showingError = true
        node.setErrorMessage(FerretDapErrors.message(error, "Cannot load Ferret values."),
            object : XDebuggerTreeNodeHyperlink("Retry") {
                override fun onClick(event: MouseEvent) = load(expected)
            })
        // A named view may be unreadable while its indexed sibling is readable.
        if (current() && hasNextKind) node.tooManyChildren(indexed ?: -1) { load(expected, skipKind = true) }
    }

    private fun nextKind() {
        kind = VariablesArgumentsFilter.INDEXED
        offset = 0
    }
}
