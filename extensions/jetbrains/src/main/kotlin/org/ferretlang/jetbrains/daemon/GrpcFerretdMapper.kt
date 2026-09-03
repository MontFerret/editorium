package org.ferretlang.jetbrains.daemon

import io.grpc.Metadata
import io.grpc.StatusRuntimeException
import org.ferretlang.jetbrains.execution.FerretdDiagnostic
import org.ferretlang.jetbrains.execution.FerretdExecutionEvent
import org.ferretlang.jetbrains.execution.FerretdExecutionOutput
import org.ferretlang.jetbrains.execution.FerretdExecutionSnapshot
import org.ferretlang.jetbrains.execution.FerretdExecutionState
import org.ferretlang.jetbrains.execution.FerretdFailure
import org.ferretlang.jetbrains.execution.FerretdFailureCategory
import org.ferretlang.jetbrains.execution.FerretdPosition
import org.ferretlang.jetbrains.execution.FerretdRange
import org.ferretlang.jetbrains.execution.FerretdRelatedInformation
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.execution.FerretdServerInfo
import org.ferretlang.jetbrains.execution.FerretdSession
import org.ferretlang.jetbrains.execution.FerretdWorkspace
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CompilationFailure
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Diagnostic
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.DiagnosticSeverity
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Execution
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionState
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.FailureCategory
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ResourceCondition
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ResourceErrorDetail
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ResourceKind
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Session as ProtocolSession
import org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.Workspace as ProtocolWorkspace
import org.ferretlang.jetbrains.protocol.google.rpc.Status
import java.nio.file.Path

internal object GrpcFerretdMapper {
    private val statusDetailsKey = Metadata.Key.of("grpc-status-details-bin", Metadata.BINARY_BYTE_MARSHALLER)

    fun serverInfo(response: GetInfoResponse): FerretdServerInfo {
        if (!response.hasServerInfo() || !response.serverInfo.hasApiVersion()) {
            protocol("get-info", "The Ferret daemon returned incomplete server information.")
        }
        val info = response.serverInfo
        if (info.version.isBlank() || info.instanceId.isBlank()) {
            protocol("get-info", "The Ferret daemon returned incomplete server information.")
        }
        return FerretdServerInfo(info.version, info.instanceId, info.apiVersion.major, info.apiVersion.minor)
    }

    fun workspace(value: ProtocolWorkspace): FerretdWorkspace {
        if (!value.hasId() || value.id.value.isBlank() || value.root.isBlank()) {
            protocol("open-workspace", "The Ferret daemon returned an incomplete workspace.")
        }
        val root = try {
            Path.of(value.root)
        } catch (error: Exception) {
            throw FerretdRpcException("open-workspace", "The Ferret daemon returned an invalid workspace root.", cause = error)
        }
        if (!root.isAbsolute) {
            protocol("open-workspace", "The Ferret daemon returned a non-absolute workspace root.")
        }
        return FerretdWorkspace(value.id.value, root.normalize())
    }

    fun session(value: ProtocolSession): FerretdSession {
        if (!value.hasId() || value.id.value.isBlank() || !value.hasSource()) {
            protocol("create-session", "The Ferret daemon returned an incomplete session.")
        }
        val source = value.source
        if (
            !source.hasWorkspaceId() ||
            source.workspaceId.value.isBlank() ||
            !normalizedRelativePath(source.relativePath) ||
            source.uri.isBlank() ||
            source.revision < 1L ||
            value.parametersList.any(String::isBlank) ||
            value.parametersList.toSet().size != value.parametersCount
        ) {
            protocol("create-session", "The Ferret daemon returned an incomplete source session.")
        }
        return FerretdSession(
            value.id.value,
            source.workspaceId.value,
            source.relativePath,
            source.uri,
            source.revision,
        )
    }

    fun execution(value: Execution, operation: String): FerretdExecutionSnapshot {
        if (
            !value.hasId() ||
            value.id.value.isBlank() ||
            !value.hasSessionId() ||
            value.sessionId.value.isBlank() ||
            !value.hasOptions() ||
            value.options.outputContentType.isBlank()
        ) {
            protocol(operation, "The Ferret daemon returned an incomplete execution.")
        }
        val state = state(value.state, operation)
        if (state == FerretdExecutionState.COMPLETED && !value.hasOutput()) {
            protocol(operation, "The Ferret daemon returned a completed execution without output.")
        }
        if (state != FerretdExecutionState.COMPLETED && value.hasOutput()) {
            protocol(operation, "The Ferret daemon returned output for a non-completed execution.")
        }
        if (value.hasOutput() && value.output.contentType.isBlank()) {
            protocol(operation, "The Ferret daemon returned output without a content type.")
        }
        if (state == FerretdExecutionState.FAILED && !value.hasFailure()) {
            protocol(operation, "The Ferret daemon returned a failed execution without failure details.")
        }
        if (state != FerretdExecutionState.FAILED && value.hasFailure()) {
            protocol(operation, "The Ferret daemon returned failure details for a non-failed execution.")
        }
        return FerretdExecutionSnapshot(
            value.id.value,
            value.sessionId.value,
            state,
            value.options.outputContentType,
            if (value.hasOutput()) FerretdExecutionOutput(value.output.contentType, value.output.data.toByteArray()) else null,
            if (value.hasFailure()) failure(value.failure, operation) else null,
        )
    }

    fun event(value: WatchExecutionResponse): FerretdExecutionEvent {
        if (!value.hasExecutionId() || value.executionId.value.isBlank() || value.sequence < 1L) {
            protocol("watch-execution", "The Ferret daemon returned an incomplete execution event.")
        }
        val protocolExecution = when (value.payloadCase) {
            WatchExecutionResponse.PayloadCase.CREATED -> value.created.execution
            WatchExecutionResponse.PayloadCase.STARTED -> value.started.execution
            WatchExecutionResponse.PayloadCase.COMPLETED -> value.completed.execution
            WatchExecutionResponse.PayloadCase.FAILED -> value.failed.execution
            WatchExecutionResponse.PayloadCase.CANCELLED -> value.cancelled.execution
            WatchExecutionResponse.PayloadCase.PAYLOAD_NOT_SET ->
                protocol("watch-execution", "The Ferret daemon returned an event without a payload.")
        }
        val execution = execution(protocolExecution, "watch-execution")
        val expected = when (value.payloadCase) {
            WatchExecutionResponse.PayloadCase.CREATED -> FerretdExecutionState.CREATED
            WatchExecutionResponse.PayloadCase.STARTED -> FerretdExecutionState.RUNNING
            WatchExecutionResponse.PayloadCase.COMPLETED -> FerretdExecutionState.COMPLETED
            WatchExecutionResponse.PayloadCase.FAILED -> FerretdExecutionState.FAILED
            WatchExecutionResponse.PayloadCase.CANCELLED -> FerretdExecutionState.CANCELLED
            WatchExecutionResponse.PayloadCase.PAYLOAD_NOT_SET -> error("unreachable")
        }
        if (execution.id != value.executionId.value || execution.state != expected) {
            protocol("watch-execution", "The Ferret daemon returned a contradictory execution event.")
        }
        return FerretdExecutionEvent(value.executionId.value, value.sequence, expected, execution)
    }

    fun error(operation: String, error: Throwable): FerretdRpcException {
        if (error is FerretdRpcException) {
            return error
        }
        if (error is StatusRuntimeException) {
            val encoded = error.trailers?.get(statusDetailsKey)
            if (encoded != null) {
                try {
                    val status = Status.parseFrom(encoded)
                    status.detailsList.forEach { detail ->
                        when (detail.typeUrl.substringAfterLast('/')) {
                            "ferretd.execution.v1.CompilationFailure" -> {
                                val failure = CompilationFailure.parseFrom(detail.value)
                                return FerretdRpcException(
                                    operation,
                                    "Ferret session compilation failed.",
                                    failure.diagnosticsList.map { diagnostic(it, operation) },
                                    error,
                                )
                            }
                            "ferretd.execution.v1.ResourceErrorDetail" -> {
                                val resource = ResourceErrorDetail.parseFrom(detail.value)
                                return FerretdRpcException(
                                    operation,
                                    resourceMessage(resource),
                                    cause = error,
                                )
                            }
                        }
                    }
                } catch (parseError: Exception) {
                    return FerretdRpcException(
                        operation,
                        "The Ferret daemon returned malformed error details.",
                        cause = parseError,
                    )
                }
            }
            val description = error.status.description?.takeUnless(String::isBlank) ?: error.status.code.name
            return FerretdRpcException(operation, "Ferret daemon $operation failed: $description", cause = error)
        }
        return FerretdRpcException(operation, "Ferret daemon $operation failed: ${error.message ?: error::class.java.simpleName}", cause = error)
    }

    private fun failure(value: org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Failure, operation: String): FerretdFailure {
        val category = when (value.category) {
            FailureCategory.FAILURE_CATEGORY_SESSION_CREATION -> FerretdFailureCategory.SESSION_CREATION
            FailureCategory.FAILURE_CATEGORY_RUNTIME -> FerretdFailureCategory.RUNTIME
            FailureCategory.FAILURE_CATEGORY_CLEANUP -> FerretdFailureCategory.CLEANUP
            FailureCategory.FAILURE_CATEGORY_UNSPECIFIED, FailureCategory.UNRECOGNIZED ->
                protocol(operation, "The Ferret daemon returned an unknown failure category.")
        }
        return FerretdFailure(category, value.message, value.diagnosticsList.map { diagnostic(it, operation) })
    }

    private fun diagnostic(value: Diagnostic, operation: String): FerretdDiagnostic {
        if (!value.hasRange() || value.severity != DiagnosticSeverity.DIAGNOSTIC_SEVERITY_ERROR) {
            protocol(operation, "The Ferret daemon returned a malformed diagnostic.")
        }
        return FerretdDiagnostic(
            value.uri,
            range(value.range, operation),
            value.code,
            value.source,
            value.message,
            value.relatedInformationList.map { related ->
                if (!related.hasRange()) {
                    protocol(operation, "The Ferret daemon returned malformed related diagnostic information.")
                }
                FerretdRelatedInformation(related.uri, range(related.range, operation), related.message)
            },
        )
    }

    private fun range(value: org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Range, operation: String): FerretdRange {
        if (!value.hasStart() || !value.hasEnd()) {
            protocol(operation, "The Ferret daemon returned a diagnostic without a complete range.")
        }
        return FerretdRange(
            FerretdPosition(value.start.line, value.start.character),
            FerretdPosition(value.end.line, value.end.character),
        )
    }

    private fun state(value: ExecutionState, operation: String): FerretdExecutionState = when (value) {
        ExecutionState.EXECUTION_STATE_CREATED -> FerretdExecutionState.CREATED
        ExecutionState.EXECUTION_STATE_RUNNING -> FerretdExecutionState.RUNNING
        ExecutionState.EXECUTION_STATE_COMPLETED -> FerretdExecutionState.COMPLETED
        ExecutionState.EXECUTION_STATE_FAILED -> FerretdExecutionState.FAILED
        ExecutionState.EXECUTION_STATE_CANCELLED -> FerretdExecutionState.CANCELLED
        ExecutionState.EXECUTION_STATE_UNSPECIFIED, ExecutionState.UNRECOGNIZED ->
            protocol(operation, "The Ferret daemon returned an unknown execution state.")
    }

    private fun resourceMessage(detail: ResourceErrorDetail): String {
        if (
            detail.resource == ResourceKind.RESOURCE_KIND_UNSPECIFIED ||
            detail.resource == ResourceKind.UNRECOGNIZED ||
            detail.condition == ResourceCondition.RESOURCE_CONDITION_UNSPECIFIED ||
            detail.condition == ResourceCondition.UNRECOGNIZED
        ) {
            protocol("rpc-status", "The Ferret daemon returned malformed resource error details.")
        }
        val resource = detail.resource.name.removePrefix("RESOURCE_KIND_").lowercase().replace('_', ' ')
        val condition = when (detail.condition) {
            ResourceCondition.RESOURCE_CONDITION_NOT_FOUND -> "was not found"
            ResourceCondition.RESOURCE_CONDITION_CLOSED -> "is closed"
            ResourceCondition.RESOURCE_CONDITION_INVALID_STATE -> "is in an invalid state"
            ResourceCondition.RESOURCE_CONDITION_INVALID_PARAMETERS -> "has invalid parameters"
            ResourceCondition.RESOURCE_CONDITION_LAGGED -> "watch lagged"
            ResourceCondition.RESOURCE_CONDITION_UNSPECIFIED, ResourceCondition.UNRECOGNIZED -> error("unreachable")
        }
        return "Ferret $resource $condition."
    }

    private fun normalizedRelativePath(value: String): Boolean {
        if (value.isBlank() || value.startsWith('/') || value.contains('\\') || value.contains('\u0000')) {
            return false
        }
        val parts = value.split('/')
        return parts.none { it.isBlank() || it == "." || it == ".." } && parts.joinToString("/") == value
    }

    private fun protocol(operation: String, message: String): Nothing = throw FerretdRpcException(operation, message)
}
