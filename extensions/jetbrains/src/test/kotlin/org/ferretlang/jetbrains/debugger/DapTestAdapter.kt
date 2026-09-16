package org.ferretlang.jetbrains.debugger

import kotlinx.coroutines.channels.Channel
import org.eclipse.lsp4j.debug.*
import org.eclipse.lsp4j.debug.services.IDebugProtocolClient
import org.eclipse.lsp4j.debug.services.IDebugProtocolServer
import java.util.Collections
import java.util.concurrent.CompletableFuture

internal class DapTestAdapter : IDebugProtocolServer {
    lateinit var client: IDebugProtocolClient
    val history: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val initialized = CompletableFuture<InitializeRequestArguments>()
    val launched = CompletableFuture<Map<String, Any>>()
    val launchResponse = CompletableFuture<Void>()
    val breakpointRequests = Channel<Pair<SetBreakpointsArguments, CompletableFuture<SetBreakpointsResponse>>>(Channel.UNLIMITED)
    val controlRequests = Channel<Pair<String, CompletableFuture<Void>>>(Channel.UNLIMITED)
    val stackRequests = Channel<Pair<StackTraceArguments, CompletableFuture<StackTraceResponse>>>(Channel.UNLIMITED)
    val disconnected = CompletableFuture<Void>()
    val terminateResponse = CompletableFuture<Void>()
    var autoTerminate = true
    var autoInitialize = true
    val initializeResponse = CompletableFuture<Capabilities>()
    var autoConfigure = true
    val configurationRequested = CompletableFuture<ConfigurationDoneArguments>()
    val configurationResponse = CompletableFuture<Void>()

    override fun initialize(args: InitializeRequestArguments): CompletableFuture<Capabilities> {
        history.add("initialize")
        initialized.complete(args)
        if (autoInitialize) initializeResponse.complete(Capabilities().apply {
            supportsConfigurationDoneRequest = true
            supportsTerminateRequest = true
        })
        return initializeResponse
    }

    override fun launch(args: Map<String, Any>): CompletableFuture<Void> {
        history.add("launch")
        launched.complete(args)
        client.initialized()
        return launchResponse
    }

    override fun setBreakpoints(args: SetBreakpointsArguments): CompletableFuture<SetBreakpointsResponse> {
        history.add("setBreakpoints")
        return CompletableFuture<SetBreakpointsResponse>().also { breakpointRequests.trySend(args to it) }
    }

    override fun configurationDone(args: ConfigurationDoneArguments): CompletableFuture<Void> {
        history.add("configurationDone")
        configurationRequested.complete(args)
        if (autoConfigure) {
            configurationResponse.complete(null)
            launchResponse.complete(null)
        }
        return configurationResponse
    }

    override fun continue_(args: ContinueArguments): CompletableFuture<ContinueResponse> =
        control("continue", args.threadId).thenApply { ContinueResponse().apply { allThreadsContinued = true } }

    override fun pause(args: PauseArguments): CompletableFuture<Void> = control("pause", args.threadId)
    override fun next(args: NextArguments): CompletableFuture<Void> = control("next", args.threadId)
    override fun stepIn(args: StepInArguments): CompletableFuture<Void> = control("stepIn", args.threadId)
    override fun stepOut(args: StepOutArguments): CompletableFuture<Void> = control("stepOut", args.threadId)

    override fun stackTrace(args: StackTraceArguments): CompletableFuture<StackTraceResponse> {
        history.add("stackTrace")
        return CompletableFuture<StackTraceResponse>().also { stackRequests.trySend(args to it) }
    }

    override fun terminate(args: TerminateArguments): CompletableFuture<Void> {
        history.add("terminate")
        if (autoTerminate) terminateResponse.complete(null)
        return terminateResponse
    }

    override fun disconnect(args: DisconnectArguments): CompletableFuture<Void> {
        history.add("disconnect")
        disconnected.complete(null)
        return CompletableFuture.completedFuture(null)
    }

    fun stop(reason: String = "breakpoint", ids: Array<Int> = emptyArray()) {
        client.stopped(StoppedEventArguments().apply {
            this.reason = reason
            threadId = 1
            allThreadsStopped = true
            hitBreakpointIds = ids
        })
    }

    private fun control(name: String, thread: Int): CompletableFuture<Void> {
        check(thread == 1)
        history.add(name)
        return CompletableFuture<Void>().also { controlRequests.trySend(name to it) }
    }
}
