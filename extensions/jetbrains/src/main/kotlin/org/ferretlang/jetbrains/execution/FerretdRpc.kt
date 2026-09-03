package org.ferretlang.jetbrains.execution

import com.google.protobuf.Struct
import java.nio.file.Path

internal interface FerretdRpc {
    suspend fun getInfo(): FerretdServerInfo

    suspend fun shutdown()

    suspend fun openWorkspace(root: Path): FerretdWorkspace

    suspend fun createSession(workspaceId: String, relativePath: String): FerretdSession

    suspend fun createExecution(sessionId: String, parameters: Struct): FerretdExecutionSnapshot

    fun watchExecution(executionId: String): FerretdExecutionWatch

    suspend fun runExecution(executionId: String): FerretdExecutionSnapshot

    suspend fun cancelExecution(executionId: String): FerretdExecutionSnapshot

    suspend fun closeExecution(executionId: String)

    suspend fun closeSession(sessionId: String)

    suspend fun close()
}

internal interface FerretdExecutionWatch {
    suspend fun next(): FerretdExecutionEvent?

    fun cancel()
}

internal data class FerretdServerInfo(
    val version: String,
    val instanceId: String,
    val apiMajor: Int,
    val apiMinor: Int,
)

internal data class FerretdWorkspace(
    val id: String,
    val root: Path,
)

internal data class FerretdSession(
    val id: String,
    val workspaceId: String,
    val relativePath: String,
    val uri: String,
    val revision: Long,
)

internal enum class FerretdExecutionState {
    CREATED,
    RUNNING,
    COMPLETED,
    FAILED,
    CANCELLED,
}

internal data class FerretdExecutionOutput(
    val contentType: String,
    val data: ByteArray,
)

internal enum class FerretdFailureCategory {
    SESSION_CREATION,
    RUNTIME,
    CLEANUP,
}

internal data class FerretdPosition(
    val line: Int,
    val character: Int,
)

internal data class FerretdRange(
    val start: FerretdPosition,
    val end: FerretdPosition,
)

internal data class FerretdRelatedInformation(
    val uri: String,
    val range: FerretdRange,
    val message: String,
)

internal data class FerretdDiagnostic(
    val uri: String,
    val range: FerretdRange,
    val code: String,
    val source: String,
    val message: String,
    val relatedInformation: List<FerretdRelatedInformation>,
)

internal data class FerretdFailure(
    val category: FerretdFailureCategory,
    val message: String,
    val diagnostics: List<FerretdDiagnostic>,
)

internal data class FerretdExecutionSnapshot(
    val id: String,
    val sessionId: String,
    val state: FerretdExecutionState,
    val outputContentType: String,
    val output: FerretdExecutionOutput?,
    val failure: FerretdFailure?,
)

internal data class FerretdExecutionEvent(
    val executionId: String,
    val sequence: Long,
    val kind: FerretdExecutionState,
    val execution: FerretdExecutionSnapshot,
)

internal class FerretdRpcException(
    val operation: String,
    message: String,
    val diagnostics: List<FerretdDiagnostic> = emptyList(),
    cause: Throwable? = null,
) : Exception(message, cause)
