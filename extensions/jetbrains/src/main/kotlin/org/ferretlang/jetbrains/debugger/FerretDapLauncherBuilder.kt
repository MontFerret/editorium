package org.ferretlang.jetbrains.debugger

import org.eclipse.lsp4j.debug.services.IDebugProtocolServer
import org.eclipse.lsp4j.jsonrpc.MessageConsumer
import org.eclipse.lsp4j.jsonrpc.MessageProducer
import org.eclipse.lsp4j.jsonrpc.RemoteEndpoint
import org.eclipse.lsp4j.jsonrpc.debug.DebugLauncher
import org.eclipse.lsp4j.jsonrpc.json.ConcurrentMessageProcessor
import org.eclipse.lsp4j.jsonrpc.json.MessageJsonHandler
import org.eclipse.lsp4j.jsonrpc.messages.ResponseError
import org.eclipse.lsp4j.jsonrpc.messages.ResponseErrorCode
import org.eclipse.lsp4j.jsonrpc.messages.ResponseMessage

internal class FerretDapLauncherBuilder(
    private val failed: (Throwable) -> Unit,
) : DebugLauncher.Builder<IDebugProtocolServer>() {
    private lateinit var handler: MessageJsonHandler
    private lateinit var endpoint: RemoteEndpoint

    init {
        setExceptionHandler { error ->
            FerretDapErrors.log("client request", error)
            ResponseError(ResponseErrorCode.InternalError, "The Ferret debug client cannot handle this adapter request.", null)
        }
    }

    override fun createJsonHandler(): MessageJsonHandler = super.createJsonHandler().also { handler = it }

    override fun createRemoteEndpoint(jsonHandler: MessageJsonHandler): RemoteEndpoint =
        super.createRemoteEndpoint(jsonHandler).also { endpoint = it }

    override fun createMessageProcessor(
        reader: MessageProducer,
        messageConsumer: MessageConsumer,
        remoteProxy: IDebugProtocolServer,
    ): ConcurrentMessageProcessor = super.createMessageProcessor(
        FerretDapMessageProducer(input, handler, failed), MessageConsumer { message ->
            // LSP4J's unmatched-response warning includes the entire response, including runtime values.
            if (message is ResponseMessage && endpoint.resolveMethod(message.id) == null) {
                failed(IllegalStateException("The Ferret debug adapter sent an unsolicited response."))
            } else messageConsumer.consume(message)
        }, remoteProxy,
    )
}
