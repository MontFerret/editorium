package org.ferretlang.jetbrains.daemon

import com.google.protobuf.Any
import io.grpc.Metadata
import io.grpc.StatusRuntimeException
import org.ferretlang.jetbrains.execution.FerretdExecutionState
import org.ferretlang.jetbrains.execution.FerretdFailureCategory
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CompilationFailure
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Diagnostic
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.DiagnosticSeverity
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Execution
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionId
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionOptions
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionState
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Failure
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.FailureCategory
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Output
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Position
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Range
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ResourceErrorDetail
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.SessionId
import org.ferretlang.jetbrains.protocol.google.rpc.Status
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GrpcFerretdMapperTest {
    @Test
    fun decodesStructuredCompilationDiagnostics() {
        val diagnostic = Diagnostic.newBuilder()
            .setUri("file:///workspace/query.fql")
            .setRange(
                Range.newBuilder()
                    .setStart(Position.newBuilder().setLine(2).setCharacter(3))
                    .setEnd(Position.newBuilder().setLine(2).setCharacter(8)),
            )
            .setSeverity(DiagnosticSeverity.DIAGNOSTIC_SEVERITY_ERROR)
            .setCode("E_PARSE")
            .setSource("ferret")
            .setMessage("unexpected token")
            .build()
        val failure = CompilationFailure.newBuilder().addDiagnostics(diagnostic).build()

        val mapped = GrpcFerretdMapper.error("create-session", statusError(Any.pack(failure)))

        assertEquals("Ferret session compilation failed.", mapped.message)
        assertEquals(1, mapped.diagnostics.size)
        assertEquals(2, mapped.diagnostics.single().range.start.line)
        assertEquals("unexpected token", mapped.diagnostics.single().message)
    }

    @Test
    fun mapsRuntimeFailuresAndRejectsContradictoryTerminalSnapshots() {
        val failure = Failure.newBuilder()
            .setCategory(FailureCategory.FAILURE_CATEGORY_RUNTIME)
            .setMessage("missing parameter")
            .build()
        val mapped = GrpcFerretdMapper.execution(execution(ExecutionState.EXECUTION_STATE_FAILED).setFailure(failure).build(), "watch")
        assertEquals(FerretdExecutionState.FAILED, mapped.state)
        assertEquals(FerretdFailureCategory.RUNTIME, mapped.failure?.category)

        assertThrows(FerretdRpcException::class.java) {
            GrpcFerretdMapper.execution(
                execution(ExecutionState.EXECUTION_STATE_CANCELLED)
                    .setOutput(Output.newBuilder().setContentType("application/json"))
                    .build(),
                "watch",
            )
        }
    }

    @Test
    fun rejectsMalformedStructuredResourceDetails() {
        val mapped = GrpcFerretdMapper.error(
            "open-workspace",
            statusError(Any.pack(ResourceErrorDetail.getDefaultInstance())),
        )
        assertTrue(mapped.message.orEmpty().contains("malformed error details"))
    }

    private fun execution(state: ExecutionState): Execution.Builder = Execution.newBuilder()
        .setId(ExecutionId.newBuilder().setValue("execution"))
        .setSessionId(SessionId.newBuilder().setValue("session"))
        .setState(state)
        .setOptions(ExecutionOptions.newBuilder().setOutputContentType("application/json"))

    private fun statusError(detail: Any): StatusRuntimeException {
        val trailers = Metadata().apply {
            put(
                Metadata.Key.of("grpc-status-details-bin", Metadata.BINARY_BYTE_MARSHALLER),
                Status.newBuilder().addDetails(detail).build().toByteArray(),
            )
        }
        return StatusRuntimeException(io.grpc.Status.INVALID_ARGUMENT, trailers)
    }
}
