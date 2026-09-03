package org.ferretlang.jetbrains.execution

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.daemon.FerretdInstallation
import org.ferretlang.jetbrains.daemon.FakeDaemonProcess
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections

class FerretExecutionClientTest {
    @Test
    fun ordersRpcCallsRegistersWatchEagerlyAndRendersTerminalJson() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        try {
            val execution = fixture.execute()
            assertEquals(0, execution.exit.awaitResult())
            assertTrue(execution.stdout.single().contains("\"id\": \"execution-1\""))
            assertEquals(
                listOf(
                    "getInfo",
                    "openWorkspace",
                    "createSession:session-1",
                    "createExecution:execution-1",
                    "watchExecution:execution-1",
                    "watchNext:execution-1",
                    "runExecution:execution-1",
                    "watchNext:execution-1",
                    "watchNext:execution-1",
                    "watchNext:execution-1",
                    "watchCancel:execution-1",
                    "closeExecution:execution-1",
                    "closeSession:session-1",
                ),
                fixture.rpc.calls.toList(),
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun rejectsMalformedLifecycleAndStillCleansExecutionBeforeSession() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.MALFORMED_SEQUENCE)
        try {
            val execution = fixture.execute()
            assertEquals(1, execution.exit.awaitResult())
            assertTrue(execution.stderr.any { it.contains("out-of-order") })
            val calls = fixture.rpc.calls.toList()
            assertTrue(calls.indexOf("closeExecution:execution-1") < calls.indexOf("closeSession:session-1"))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun repeatedCancellationSendsOneRpcAndConcurrentRunsRemainIsolated() = runBlocking {
        val fixture = fixture(
            FakeFerretdRpc.Outcome.WAIT_FOR_CANCELLATION,
            FakeFerretdRpc.Outcome.WAIT_FOR_CANCELLATION,
        )
        try {
            val first = fixture.execute("first.fql")
            val second = fixture.execute("second.fql")
            first.awaitStarted()
            second.awaitStarted()

            assertTrue(first.handle.cancel())
            assertFalse(first.handle.cancel())
            assertEquals(130, first.exit.awaitResult())
            assertFalse(second.exit.isCompleted)
            assertTrue(second.handle.cancel())
            assertEquals(130, second.exit.awaitResult())

            assertEquals(1, fixture.rpc.calls.count { it == "cancelExecution:execution-1" })
            assertEquals(1, fixture.rpc.calls.count { it == "cancelExecution:execution-2" })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun stopBeforeExecutionIdAbortsSetupAndClosesTheSession() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val gate = CompletableDeferred<Unit>()
        fixture.rpc.createSessionGate = gate
        try {
            val execution = fixture.execute()
            withTimeout(5_000L) {
                while (fixture.rpc.calls.none { it.startsWith("createSession:") }) {
                    delay(5L)
                }
            }
            assertTrue(execution.handle.cancel())
            gate.complete(Unit)

            assertEquals(130, execution.exit.awaitResult())
            assertTrue(fixture.rpc.calls.none { it.startsWith("createExecution:") })
            assertTrue(fixture.rpc.calls.none { it.startsWith("closeExecution:") })
            assertTrue(fixture.rpc.calls.any { it == "closeSession:session-1" })
        } finally {
            gate.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun stopWhileRunRpcIsPendingCancelsWithoutWaitingForRunResponse() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.WAIT_FOR_CANCELLATION)
        val gate = CompletableDeferred<Unit>()
        fixture.rpc.runExecutionGate = gate
        try {
            val execution = fixture.execute()
            withTimeout(5_000L) {
                while (fixture.rpc.calls.none { it.startsWith("runExecution:") }) {
                    delay(5L)
                }
            }
            assertTrue(execution.handle.cancel())
            withTimeout(5_000L) {
                while (fixture.rpc.calls.none { it.startsWith("cancelExecution:") }) {
                    delay(5L)
                }
            }
            gate.complete(Unit)

            assertEquals(130, execution.exit.awaitResult())
            assertEquals(1, fixture.rpc.calls.count { it == "cancelExecution:execution-1" })
        } finally {
            gate.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun cleanupWarningsDoNotReplaceACommittedSuccess() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        fixture.rpc.closeExecutionFailure = IllegalStateException("execution cleanup")
        fixture.rpc.closeSessionFailure = IllegalStateException("session cleanup")
        try {
            val execution = fixture.execute()
            assertEquals(0, execution.exit.awaitResult())
            assertEquals(2, execution.stderr.count { it.startsWith("Warning:") })
        } finally {
            fixture.close()
        }
    }

    private fun fixture(vararg outcomes: FakeFerretdRpc.Outcome): Fixture {
        val root = Files.createTempDirectory("ferret-client-test-")
        val version = "1.0.0-alpha.5"
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val rpc = FakeFerretdRpc(version, root, outcomes.toList())
        val process = FakeDaemonProcess.ready(version)
        val connection = FerretdDaemonConnection.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, token ->
                check(token.length == 43)
                check(token.none { it == '=' })
                process
            },
            { port, token ->
                check(port == 43123)
                check(token.length == 43)
                rpc
            },
        )
        return Fixture(root, scope, rpc, connection)
    }

    private data class Fixture(
        val root: Path,
        val scope: CoroutineScope,
        val rpc: FakeFerretdRpc,
        val connection: FerretdDaemonConnection,
    ) {
        fun execute(relativePath: String = "main.fql"): RecordingSink {
            val source = Files.writeString(root.resolve(relativePath), "RETURN 1")
            val sink = RecordingSink()
            sink.handle = FerretExecutionClient(connection).start(
                FerretExecutionInput(
                    source.toString(),
                    root.toString(),
                    null,
                    FerretParameterBindings.EMPTY,
                ),
                sink,
            )
            return sink
        }

        suspend fun close() {
            connection.closeForTest()
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    private class RecordingSink : FerretExecutionSink {
        val system = Collections.synchronizedList(mutableListOf<String>())
        val stdout = Collections.synchronizedList(mutableListOf<String>())
        val stderr = Collections.synchronizedList(mutableListOf<String>())
        val exit = CompletableDeferred<Int>()
        lateinit var handle: FerretExecutionHandle

        override fun system(message: String) {
            system += message
        }

        override fun stdout(message: String) {
            stdout += message
        }

        override fun stderr(message: String) {
            stderr += message
        }

        override fun internal(message: String, cause: Throwable?) = Unit

        override fun terminate(exitCode: Int) {
            exit.complete(exitCode)
        }

        suspend fun awaitStarted() {
            withTimeout(5_000L) {
                while (system.none { it == "Ferret execution started." }) {
                    delay(5L)
                }
            }
        }
    }

    private suspend fun <T> CompletableDeferred<T>.awaitResult(): T = withTimeout(5_000L) { await() }
}
