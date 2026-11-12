package org.ferretlang.jetbrains.daemon

import com.google.protobuf.Any
import com.google.protobuf.ByteString
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
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ResourceCondition
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ResourceErrorDetail
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ResourceKind
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.Session
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.SessionId
import org.ferretlang.jetbrains.protocol.ferretd.execution.v1.SourceSnapshot
import org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.WorkspaceId
import org.ferretlang.jetbrains.protocol.google.rpc.Status
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

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

        val partial = Output.newBuilder().setData(ByteString.copyFromUtf8("prefix")).build()
        val failed = GrpcFerretdMapper.execution(
            execution(ExecutionState.EXECUTION_STATE_FAILED).setFailure(failure).setOutput(partial).build(), "watch",
        )
        assertEquals(mapped.failure, failed.failure)
        assertArrayEquals(partial.data.toByteArray(), failed.output!!.data)
        val cancelled = GrpcFerretdMapper.execution(execution(ExecutionState.EXECUTION_STATE_CANCELLED).setOutput(partial).build(), "watch")
        assertEquals(FerretdExecutionState.CANCELLED, cancelled.state)
        assertArrayEquals(partial.data.toByteArray(), cancelled.output!!.data)
        assertThrows(FerretdRpcException::class.java) {
            GrpcFerretdMapper.execution(execution(ExecutionState.EXECUTION_STATE_RUNNING).setOutput(partial).build(), "watch")
        }
        assertThrows(FerretdRpcException::class.java) {
            GrpcFerretdMapper.execution(execution(ExecutionState.EXECUTION_STATE_FAILED).setOutput(partial).build(), "watch")
        }
    }

    @Test
    fun preservesTerminalOutputPresenceAndMetadata() {
        val completed = execution(ExecutionState.EXECUTION_STATE_COMPLETED)
        assertEquals(null, GrpcFerretdMapper.execution(completed.build(), "watch").output)
        for (type in listOf("", "application/json")) {
            for (content in listOf("", """{"id":1}""")) {
                completed.setOutput(Output.newBuilder().setContentType(type).setData(ByteString.copyFromUtf8(content)))
                val output = GrpcFerretdMapper.execution(Execution.parseFrom(completed.build().toByteArray()), "watch").output!!
                assertEquals(type, output.contentType)
                assertArrayEquals(content.toByteArray(), output.data)
            }
        }
    }

    @Test
    fun preservesReportedAndUnreportedSessionRuntimeNames() {
        val source = SourceSnapshot.newBuilder()
            .setWorkspaceId(WorkspaceId.newBuilder().setValue("workspace"))
            .setUri("file:///query.fql")
            .setRelativePath("query.fql")
            .setRevision(1)
        val session = Session.newBuilder()
            .setId(SessionId.newBuilder().setValue("session"))
            .setSource(source)
        assertEquals("", GrpcFerretdMapper.session(session.build()).runtimeName)
        assertEquals("worker", GrpcFerretdMapper.session(session.setRuntimeName("worker").build()).runtimeName)
    }

    @Test
    fun reportsRuntimeDetailsBeforeTransportStatus() {
        for ((code, condition, message) in listOf(
            Triple(io.grpc.Status.NOT_FOUND, ResourceCondition.RESOURCE_CONDITION_NOT_FOUND, "was not found"),
            Triple(io.grpc.Status.UNAVAILABLE, ResourceCondition.RESOURCE_CONDITION_UNAVAILABLE, "is unavailable"),
            Triple(io.grpc.Status.DEADLINE_EXCEEDED, ResourceCondition.RESOURCE_CONDITION_UNAVAILABLE, "is unavailable"),
        )) {
            val detail = ResourceErrorDetail.newBuilder().setResource(ResourceKind.RESOURCE_KIND_RUNTIME).setCondition(condition)
            val cause = statusError(Any.pack(detail.build()), code, "worker lookup failed")
            val mapped = GrpcFerretdMapper.error("create-session", cause)
            assertEquals("Ferret runtime $message: worker lookup failed", mapped.message)
            assertEquals(cause, mapped.cause)
        }
    }

    @Test
    fun rejectsMalformedStructuredResourceDetails() {
        val mapped = GrpcFerretdMapper.error(
            "open-workspace",
            statusError(Any.pack(ResourceErrorDetail.getDefaultInstance())),
        )
        assertTrue(mapped.message.orEmpty().contains("malformed error details"))
        val invalid = ResourceErrorDetail.newBuilder()
            .setResource(ResourceKind.RESOURCE_KIND_SOURCE)
            .setCondition(ResourceCondition.RESOURCE_CONDITION_UNAVAILABLE)
        assertTrue(GrpcFerretdMapper.error("create-session", statusError(Any.pack(invalid.build())))
            .message.orEmpty().contains("malformed error details"))
    }

    @Test
    fun preservesWorkingDirectoryPresenceWithoutTouchingTheFilesystem() {
        val absent = GrpcFerretdMapper.execution(
            execution(ExecutionState.EXECUTION_STATE_CREATED).build(),
            "create-execution",
        )
        assertEquals(null, absent.options.workingDirectory)

        val runtime = Files.createTempDirectory("ferret-mapper-runtime-").toRealPath().resolve("not-created")
        val present = GrpcFerretdMapper.execution(
            execution(ExecutionState.EXECUTION_STATE_CREATED)
                .setOptions(
                    ExecutionOptions.newBuilder()
                        .setOutputContentType("application/json")
                        .setWorkingDirectory(runtime.toString()),
                )
                .build(),
            "create-execution",
        )
        assertEquals(runtime, present.options.workingDirectory)
    }

    @Test
    fun rejectsBlankRelativeAndNonNormalizedSnapshotDirectories() {
        val root = Files.createTempDirectory("ferret-mapper-root-").toRealPath()
        val invalid = listOf("", "relative", root.resolve("child").resolve("..").toString())
        invalid.forEach { workingDirectory ->
            assertThrows(FerretdRpcException::class.java) {
                GrpcFerretdMapper.execution(
                    execution(ExecutionState.EXECUTION_STATE_CREATED)
                        .setOptions(
                            ExecutionOptions.newBuilder()
                                .setOutputContentType("application/json")
                                .setWorkingDirectory(workingDirectory),
                        )
                        .build(),
                    "create-execution",
                )
            }
        }
    }

    @Test
    fun mapsInvalidExecutionOptionsDetails() {
        val detail = ResourceErrorDetail.newBuilder()
            .setResource(ResourceKind.RESOURCE_KIND_EXECUTION)
            .setCondition(ResourceCondition.RESOURCE_CONDITION_INVALID_OPTIONS)
            .build()

        val mapped = GrpcFerretdMapper.error("create-execution", statusError(Any.pack(detail)))

        assertEquals("Ferret execution has invalid execution options.", mapped.message)
    }

    private fun execution(state: ExecutionState): Execution.Builder = Execution.newBuilder()
        .setId(ExecutionId.newBuilder().setValue("execution"))
        .setSessionId(SessionId.newBuilder().setValue("session"))
        .setState(state)
        .setOptions(ExecutionOptions.newBuilder().setOutputContentType("application/json"))

    private fun statusError(detail: Any, code: io.grpc.Status = io.grpc.Status.INVALID_ARGUMENT, message: String = ""): StatusRuntimeException {
        val trailers = Metadata().apply {
            put(
                Metadata.Key.of("grpc-status-details-bin", Metadata.BINARY_BYTE_MARSHALLER),
                Status.newBuilder().setCode(code.code.value()).setMessage(message).addDetails(detail).build().toByteArray(),
            )
        }
        return StatusRuntimeException(code.withDescription(message), trailers)
    }
}
