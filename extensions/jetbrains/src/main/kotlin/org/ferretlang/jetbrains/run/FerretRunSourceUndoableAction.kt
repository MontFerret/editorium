package org.ferretlang.jetbrains.run

import com.intellij.openapi.command.undo.BasicUndoableAction

internal class FerretRunSourceUndoableAction(
    private val configuration: FerretRunConfiguration,
    private val before: FerretRunSourceState,
    private val after: FerretRunSourceState,
) : BasicUndoableAction() {
    override fun undo() = restore(before)

    override fun redo() = restore(after)

    private fun restore(state: FerretRunSourceState) {
        configuration.sourcePath = state.source
        configuration.name = state.name
        configuration.setNameChangedByUser(!state.generatedName)
    }
}

internal data class FerretRunSourceState(val source: String, val name: String, val generatedName: Boolean)
