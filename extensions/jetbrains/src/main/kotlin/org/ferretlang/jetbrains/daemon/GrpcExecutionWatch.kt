package org.ferretlang.jetbrains.daemon

import io.grpc.stub.ClientCallStreamObserver
import io.grpc.stub.ClientResponseObserver
import kotlinx.coroutines.channels.Channel
import org.ferretlang.jetbrains.execution.FerretdExecutionEvent
import org.ferretlang.jetbrains.execution.FerretdExecutionWatch
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse
import java.util.concurrent.atomic.AtomicBoolean

internal class GrpcExecutionWatch :
    FerretdExecutionWatch,
    ClientResponseObserver<WatchExecutionRequest, WatchExecutionResponse> {
    private val events = Channel<FerretdExecutionEvent>(Channel.UNLIMITED)
    private val cancelled = AtomicBoolean()
    @Volatile
    private var stream: ClientCallStreamObserver<WatchExecutionRequest>? = null

    override fun beforeStart(requestStream: ClientCallStreamObserver<WatchExecutionRequest>) {
        stream = requestStream
        if (cancelled.get()) {
            requestStream.cancel("Ferret execution watch cancelled", null)
        }
    }

    override fun onNext(value: WatchExecutionResponse) {
        try {
            events.trySend(GrpcFerretdMapper.event(value)).getOrThrow()
        } catch (error: Throwable) {
            events.close(error)
            cancel()
        }
    }

    override fun onError(error: Throwable) {
        events.close(GrpcFerretdMapper.error("watch-execution", error))
    }

    override fun onCompleted() {
        events.close()
    }

    override suspend fun next(): FerretdExecutionEvent? {
        val result = events.receiveCatching()
        result.exceptionOrNull()?.let { throw it }
        return result.getOrNull()
    }

    override fun cancel() {
        if (cancelled.compareAndSet(false, true)) {
            stream?.cancel("Ferret execution watch cancelled", null)
            events.close()
        }
    }
}
