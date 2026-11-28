package org.ferretlang.jetbrains.debugger

import org.eclipse.lsp4j.debug.VariablesArguments

/** LSP4J assigns the sequence while writing the request. Only DAP arguments go on the wire. */
internal class FerretVariableRequest : VariablesArguments() {
    @Transient var sequence: Int? = null
}
