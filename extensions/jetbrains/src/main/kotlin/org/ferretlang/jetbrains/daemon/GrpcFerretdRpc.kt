package org.ferretlang.jetbrains.daemon

import com.google.protobuf.Struct
import io.grpc.ClientInterceptors
import io.grpc.ManagedChannel
import io.grpc.Metadata
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder
import io.grpc.stub.MetadataUtils
import io.grpc.stub.StreamObserver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.ferretlang.jetbrains.execution.FerretdExecutionSnapshot
import org.ferretlang.jetbrains.execution.FerretdExecutionWatch
import org.ferretlang.jetbrains.execution.FerretdRpc
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.execution.FerretdServerInfo
import org.ferretlang.jetbrains.execution.FerretdSession
import org.ferretlang.jetbrains.execution.FerretdWorkspace
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ApiVersion
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.DaemonServiceGrpc
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionId
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionOptions
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionServiceGrpc
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.SessionId
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest
import org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest
import org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse
import org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.WorkspaceId
import org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.WorkspaceServiceGrpc
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class GrpcFerretdRpc private constructor(
    private val channel: ManagedChannel,
    token: String,
) : FerretdRpc {
    private val authenticatedChannel = ClientInterceptors.intercept(
        channel,
        MetadataUtils.newAttachHeadersInterceptor(Metadata().apply {
            put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer $token")
        }),
    )
    private val daemon = DaemonServiceGrpc.newStub(authenticatedChannel)
    private val workspaces = WorkspaceServiceGrpc.newStub(authenticatedChannel)
    private val executions = ExecutionServiceGrpc.newStub(authenticatedChannel)

    override suspend fun getInfo(): FerretdServerInfo = GrpcFerretdMapper.serverInfo(
        unary("get-info") { observer ->
            daemon.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS).getInfo(
                GetInfoRequest.newBuilder()
                    .setClientApi(ApiVersion.newBuilder().setMajor(API_MAJOR).setMinor(API_MINOR))
                    .build(),
                observer,
            )
        },
    )

    override suspend fun shutdown() {
        unary<org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ShutdownResponse>("shutdown") { observer ->
            daemon.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .shutdown(ShutdownRequest.getDefaultInstance(), observer)
        }
    }

    override suspend fun openWorkspace(root: Path): FerretdWorkspace {
        val response = unary<OpenResponse>("open-workspace") { observer ->
            workspaces.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .open(OpenRequest.newBuilder().setRoot(root.toString()).build(), observer)
        }
        if (!response.hasWorkspace()) {
            throw FerretdRpcException("open-workspace", "The Ferret daemon returned no workspace.")
        }
        return GrpcFerretdMapper.workspace(response.workspace)
    }

    override suspend fun createSession(workspaceId: String, relativePath: String): FerretdSession {
        val response = unary<CreateSessionResponse>("create-session") { observer ->
            executions.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS).createSession(
                CreateSessionRequest.newBuilder()
                    .setWorkspaceId(WorkspaceId.newBuilder().setValue(workspaceId))
                    .setRelativePath(relativePath)
                    .build(),
                observer,
            )
        }
        if (!response.hasSession()) {
            throw FerretdRpcException("create-session", "The Ferret daemon returned no session.")
        }
        return GrpcFerretdMapper.session(response.session)
    }

    override suspend fun createExecution(sessionId: String, parameters: Struct): FerretdExecutionSnapshot {
        val response = unary<CreateExecutionResponse>("create-execution") { observer ->
            executions.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS).createExecution(
                CreateExecutionRequest.newBuilder()
                    .setSessionId(SessionId.newBuilder().setValue(sessionId))
                    .setParameters(parameters)
                    .setOptions(ExecutionOptions.newBuilder().setOutputContentType(JSON_CONTENT_TYPE))
                    .build(),
                observer,
            )
        }
        if (!response.hasExecution()) {
            throw FerretdRpcException("create-execution", "The Ferret daemon returned no execution.")
        }
        return GrpcFerretdMapper.execution(response.execution, "create-execution")
    }

    override fun watchExecution(executionId: String): FerretdExecutionWatch {
        val watch = GrpcExecutionWatch()
        executions.watchExecution(
            WatchExecutionRequest.newBuilder().setId(ExecutionId.newBuilder().setValue(executionId)).build(),
            watch,
        )
        return watch
    }

    override suspend fun runExecution(executionId: String): FerretdExecutionSnapshot {
        val response = unary<RunExecutionResponse>("run-execution") { observer ->
            executions.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS).runExecution(
                RunExecutionRequest.newBuilder().setId(ExecutionId.newBuilder().setValue(executionId)).build(),
                observer,
            )
        }
        if (!response.hasExecution()) {
            throw FerretdRpcException("run-execution", "The Ferret daemon returned no execution.")
        }
        return GrpcFerretdMapper.execution(response.execution, "run-execution")
    }

    override suspend fun cancelExecution(executionId: String): FerretdExecutionSnapshot {
        val response = unary<CancelExecutionResponse>("cancel-execution") { observer ->
            executions.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS).cancelExecution(
                CancelExecutionRequest.newBuilder().setId(ExecutionId.newBuilder().setValue(executionId)).build(),
                observer,
            )
        }
        if (!response.hasExecution()) {
            throw FerretdRpcException("cancel-execution", "The Ferret daemon returned no execution.")
        }
        return GrpcFerretdMapper.execution(response.execution, "cancel-execution")
    }

    override suspend fun closeExecution(executionId: String) {
        unary<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse>("close-execution") { observer ->
            executions.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS).closeExecution(
                CloseExecutionRequest.newBuilder().setId(ExecutionId.newBuilder().setValue(executionId)).build(),
                observer,
            )
        }
    }

    override suspend fun closeSession(sessionId: String) {
        unary<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse>("close-session") { observer ->
            executions.withDeadlineAfter(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS).closeSession(
                CloseSessionRequest.newBuilder().setId(SessionId.newBuilder().setValue(sessionId)).build(),
                observer,
            )
        }
    }

    override suspend fun close() {
        withContext(Dispatchers.IO) {
            channel.shutdownNow()
            channel.awaitTermination(CONTROL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    private suspend fun <Response> unary(
        operation: String,
        invoke: (StreamObserver<Response>) -> Unit,
    ): Response = suspendCancellableCoroutine { continuation ->
        val completed = AtomicBoolean()
        var response: Response? = null
        val observer = object : StreamObserver<Response> {
            override fun onNext(value: Response) {
                if (response != null) {
                    if (completed.compareAndSet(false, true)) {
                        continuation.resumeWithException(
                            FerretdRpcException(operation, "The Ferret daemon returned multiple unary responses."),
                        )
                    }
                } else {
                    response = value
                }
            }

            override fun onError(error: Throwable) {
                if (completed.compareAndSet(false, true)) {
                    continuation.resumeWithException(GrpcFerretdMapper.error(operation, error))
                }
            }

            override fun onCompleted() {
                if (completed.compareAndSet(false, true)) {
                    response?.let(continuation::resume) ?: continuation.resumeWithException(
                        FerretdRpcException(operation, "The Ferret daemon returned no unary response."),
                    )
                }
            }
        }
        try {
            invoke(observer)
        } catch (error: Throwable) {
            if (completed.compareAndSet(false, true)) {
                continuation.resumeWithException(GrpcFerretdMapper.error(operation, error))
            }
        }
    }

    companion object {
        const val API_MAJOR = 1
        const val API_MINOR = 1
        const val JSON_CONTENT_TYPE = "application/json"
        private const val CONTROL_TIMEOUT_SECONDS = 5L

        fun connect(port: Int, token: String): GrpcFerretdRpc = GrpcFerretdRpc(
            NettyChannelBuilder.forAddress("127.0.0.1", port).usePlaintext().build(),
            token,
        )
    }
}
