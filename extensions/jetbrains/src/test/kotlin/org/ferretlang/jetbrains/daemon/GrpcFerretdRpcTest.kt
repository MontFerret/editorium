package org.ferretlang.jetbrains.daemon

import io.grpc.Context
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder
import io.grpc.stub.StreamObserver
import kotlinx.coroutines.runBlocking
import org.ferretlang.jetbrains.execution.FerretdExecutionOptions
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionServiceGrpc
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Session
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.SessionId
import java.net.InetSocketAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class GrpcFerretdRpcTest {
    @Test
    fun createsSessionUsingDaemonDefault() {
        val request = GrpcFerretdRpc.toProtocolCreateSessionRequest("workspace", "query.fql", "")
        assertEquals("workspace", request.workspaceId.value)
        assertEquals("query.fql", request.relativePath)
        assertEquals("", request.runtimeName)
        assertEquals("WireApp", GrpcFerretdRpc.toProtocolCreateSessionRequest("workspace", "query.fql", "WireApp").runtimeName)
    }

    @Test
    fun malformedSessionWithIdIsClosedUsingTheShortControlDeadline() {
        val acquisition = AtomicLong()
        val cleanup = AtomicLong()
        val closed = AtomicReference<String>()
        val service = object : ExecutionServiceGrpc.ExecutionServiceImplBase() {
            override fun createSession(request: CreateSessionRequest, observer: StreamObserver<CreateSessionResponse>) {
                acquisition.set(requireNotNull(Context.current().deadline).timeRemaining(TimeUnit.MILLISECONDS))
                val session = Session.newBuilder().setId(SessionId.newBuilder().setValue("late-session"))
                observer.onNext(CreateSessionResponse.newBuilder().setSession(session).build())
                observer.onCompleted()
            }

            override fun closeSession(request: CloseSessionRequest, observer: StreamObserver<CloseSessionResponse>) {
                cleanup.set(requireNotNull(Context.current().deadline).timeRemaining(TimeUnit.MILLISECONDS))
                closed.set(request.id.value)
                observer.onNext(CloseSessionResponse.getDefaultInstance())
                observer.onCompleted()
            }
        }
        val server = NettyServerBuilder.forAddress(InetSocketAddress("127.0.0.1", 0)).addService(service).build().start()
        val rpc = GrpcFerretdRpc.connect(server.port, "test-credential")
        try {
            org.junit.Assert.assertThrows(FerretdRpcException::class.java) {
                runBlocking { rpc.createSession("workspace", "query.fql", "WireApp") }
            }
            assertEquals("late-session", closed.get())
            assertTrue("CreateSession deadline: ${acquisition.get()} ms", acquisition.get() in 5_001L..30_100L)
            assertTrue("CloseSession deadline: ${cleanup.get()} ms", cleanup.get() in 1L..5_100L)
        } finally {
            runBlocking { rpc.close() }
            server.shutdownNow().awaitTermination(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun mapsWorkingDirectoryOnlyWhenPresent() {
        val absent = GrpcFerretdRpc.toProtocolExecutionOptions(
            FerretdExecutionOptions("application/json", null),
        )
        assertEquals("application/json", absent.outputContentType)
        assertFalse(absent.hasWorkingDirectory())

        val runtime = Files.createTempDirectory("ferret-grpc-runtime-").toRealPath()
        val present = GrpcFerretdRpc.toProtocolExecutionOptions(
            FerretdExecutionOptions("application/json", runtime.toString()),
        )
        assertTrue(present.hasWorkingDirectory())
        assertEquals(runtime.toString(), present.workingDirectory)
    }
}
