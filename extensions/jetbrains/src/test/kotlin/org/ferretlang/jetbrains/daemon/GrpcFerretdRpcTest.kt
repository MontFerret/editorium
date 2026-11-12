package org.ferretlang.jetbrains.daemon

import com.google.protobuf.Struct
import io.grpc.Context
import io.grpc.Status
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder
import io.grpc.stub.StreamObserver
import kotlinx.coroutines.runBlocking
import org.ferretlang.jetbrains.execution.FerretdExecutionOptions
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionServiceGrpc
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Session
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.SessionId
import java.net.InetSocketAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
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
    fun rejectedSessionsCloseOnlyAnObservedIdAndPreserveTheAcquisitionError() {
        val acquisition = AtomicLong()
        val cleanup = AtomicLong()
        val closed = CopyOnWriteArrayList<String>()
        val executions = AtomicInteger()
        val service = object : ExecutionServiceGrpc.ExecutionServiceImplBase() {
            override fun createSession(request: CreateSessionRequest, observer: StreamObserver<CreateSessionResponse>) {
                acquisition.set(requireNotNull(Context.current().deadline).timeRemaining(TimeUnit.MILLISECONDS))
                val id = request.runtimeName
                if (id != "no-message") {
                    val session = Session.newBuilder().setId(SessionId.newBuilder().setValue(id)).setRuntimeName(id)
                    if (id != "malformed") {
                        session.sourceBuilder.setWorkspaceId(request.workspaceId).setRelativePath(request.relativePath)
                            .setUri("file:///query.fql").setRevision(1)
                    }
                    observer.onNext(CreateSessionResponse.newBuilder().setSession(session).build())
                }
                if (id == "malformed") observer.onCompleted() else observer.onError(Status.UNAVAILABLE.asRuntimeException())
            }

            override fun closeSession(request: CloseSessionRequest, observer: StreamObserver<CloseSessionResponse>) {
                cleanup.set(requireNotNull(Context.current().deadline).timeRemaining(TimeUnit.MILLISECONDS))
                closed.add(request.id.value)
                if (request.id.value == "close-fails") {
                    observer.onError(Status.PERMISSION_DENIED.asRuntimeException())
                } else {
                    observer.onNext(CloseSessionResponse.getDefaultInstance())
                    observer.onCompleted()
                }
            }

            override fun createExecution(request: CreateExecutionRequest, observer: StreamObserver<CreateExecutionResponse>) {
                executions.incrementAndGet()
                observer.onError(Status.INTERNAL.asRuntimeException())
            }
        }
        val server = NettyServerBuilder.forAddress(InetSocketAddress("127.0.0.1", 0)).addService(service).build().start()
        val rpc = GrpcFerretdRpc.connect(server.port, "test-credential")
        try {
            for (scenario in listOf("malformed", "no-message", "late-error", "close-fails")) {
                val error = assertThrows(FerretdRpcException::class.java) {
                    runBlocking {
                        val session = rpc.createSession("workspace", "query.fql", scenario)
                        rpc.createExecution(session.id, Struct.getDefaultInstance(), FerretdExecutionOptions("application/json", null))
                    }
                }
                assertEquals("create-session", error.operation)
                if (scenario != "malformed") assertTrue(error.cause?.message.orEmpty().contains("UNAVAILABLE"))
                if (scenario == "close-fails") {
                    val failure = error.suppressed.single() as FerretdRpcException
                    assertEquals("close-session", failure.operation)
                    assertTrue(failure.cause?.message.orEmpty().contains("PERMISSION_DENIED"))
                } else {
                    assertTrue(error.suppressed.isEmpty())
                }
            }
            assertEquals(listOf("malformed", "late-error", "close-fails"), closed.toList())
            assertEquals(0, executions.get())
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
