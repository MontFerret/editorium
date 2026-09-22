package org.ferretlang.jetbrains.debugger

import org.eclipse.lsp4j.jsonrpc.MessageIssueHandler
import org.eclipse.lsp4j.jsonrpc.json.MessageJsonHandler
import org.eclipse.lsp4j.jsonrpc.json.StreamMessageProducer
import java.io.InputStream

/** LSP4J retains all parsing; its normally log-only failures terminate this connection. */
internal class FerretDapMessageProducer(
    input: InputStream,
    handler: MessageJsonHandler,
    private val failed: (Throwable) -> Unit,
) : StreamMessageProducer(input, handler, MessageIssueHandler { _, _ ->
    failed(IllegalStateException("The Ferret debug adapter sent an invalid DAP message."))
}) {
    override fun fireError(error: Throwable) {
        failed(error)
        close()
    }

    override fun fireStreamClosed(cause: Exception) {
        failed(cause)
    }
}
