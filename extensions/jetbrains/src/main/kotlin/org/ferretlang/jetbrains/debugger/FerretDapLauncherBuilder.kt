package org.ferretlang.jetbrains.debugger

import org.eclipse.lsp4j.debug.services.IDebugProtocolServer
import org.eclipse.lsp4j.jsonrpc.MessageConsumer
import org.eclipse.lsp4j.jsonrpc.MessageProducer
import org.eclipse.lsp4j.jsonrpc.debug.DebugLauncher
import org.eclipse.lsp4j.jsonrpc.json.ConcurrentMessageProcessor
import org.eclipse.lsp4j.jsonrpc.json.MessageJsonHandler

internal class FerretDapLauncherBuilder(
    private val failed: (Throwable) -> Unit,
) : DebugLauncher.Builder<IDebugProtocolServer>() {
    private lateinit var handler: MessageJsonHandler

    override fun createJsonHandler(): MessageJsonHandler = super.createJsonHandler().also { handler = it }

    override fun createMessageProcessor(
        reader: MessageProducer,
        messageConsumer: MessageConsumer,
        remoteProxy: IDebugProtocolServer,
    ): ConcurrentMessageProcessor = super.createMessageProcessor(
        FerretDapMessageProducer(input, handler, failed), messageConsumer, remoteProxy,
    )
}
