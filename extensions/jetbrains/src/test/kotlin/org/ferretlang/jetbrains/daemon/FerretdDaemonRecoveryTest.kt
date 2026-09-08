package org.ferretlang.jetbrains.daemon

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import org.ferretlang.jetbrains.execution.FakeFerretdRpc
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class FerretdDaemonRecoveryTest {
    @Test
    fun disposalWaitsForForcedProcessTermination() = runBlocking {
        val process = FakeDaemonProcess.ready(version, requiresForcedTermination = true)
        val fixture = fixture(process)
        try {
            val generation = fixture.connection.generation()
            fixture.connection.closeForTest()
            assertTrue(generation.stopped.isCompleted)
            assertFalse(process.isAlive)
            assertEquals(1, process.forcedDestroyCalls.get())
            assertEquals(1, fixture.rpc.calls.count { it == "close" })
        } finally {
            fixture.connection.closeForTest()
            fixture.scope.cancel()
            fixture.root.toFile().deleteRecursively()
        }
    }

    @Test
    fun disposalWaitsForAnInvalidatedGenerationStillBeingCleanedUp() = runBlocking {
        val fixture = fixture()
        val gate = CompletableDeferred<Unit>()
        fixture.rpc.closeGate = gate
        try {
            val generation = fixture.connection.generation()
            generation.lost.complete(FerretdConnectionException("Lost generation"))
            withTimeout(5_000L) { fixture.rpc.closeEntered.await() }
            val closing = async(start = CoroutineStart.UNDISPATCHED) { fixture.connection.closeForTest() }
            assertFalse(closing.isCompleted)
            gate.complete(Unit)
            withTimeout(5_000L) { closing.await() }
            assertTrue(generation.stopped.isCompleted)
            assertFalse(generation.process.isAlive)
            assertEquals(1, fixture.rpc.calls.count { it == "close" })
        } finally {
            gate.complete(Unit)
            fixture.connection.closeForTest()
            fixture.scope.cancel()
            fixture.root.toFile().deleteRecursively()
        }
    }

    @Test
    fun aDeadProcessIsNeverReusedWhileExitObservationIsPending() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val root = Files.createTempDirectory("ferretd-exit-observation-").toRealPath()
        val gate = CountDownLatch(1)
        val processes = listOf(FakeDaemonProcess.ready(version, exitObservationGate = gate), FakeDaemonProcess.ready(version))
        val rpcs = processes.map { process -> FakeFerretdRpc(version, root, emptyList(), onShutdown = process::destroy) }
        val starts = AtomicInteger()
        val launcher = FerretdDaemonLauncher.testing(scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> processes[starts.getAndIncrement()] },
            { _, _ -> rpcs[starts.get() - 1] },
        )
        val connection = FerretdDaemonConnection.testing(scope, launcher)
        try {
            val first = connection.generation()
            processes.first().crash(23)
            assertFalse(first.lost.isCompleted)
            val second = connection.generation()
            assertNotSame(first, second)
            assertSame(processes.last(), second.process)
            withTimeout(5_000L) { first.stopped.await() }
            assertEquals(1, rpcs.first().calls.count { it == "close" })
        } finally {
            gate.countDown()
            connection.closeForTest()
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun lossOfALiveGenerationStopsItsProcessAndChannel() = runBlocking {
        val fixture = fixture()
        try {
            val generation = fixture.connection.generation()
            assertTrue(generation.process.isAlive)
            generation.lost.complete(FerretdConnectionException("Duplicate readiness"))
            withTimeout(5_000L) { generation.stopped.await() }
            assertFalse(generation.process.isAlive)
            assertEquals(1, fixture.rpc.calls.count { it == "close" })
        } finally {
            fixture.connection.closeForTest()
            fixture.scope.cancel()
            fixture.root.toFile().deleteRecursively()
        }
    }

    @Test
    fun duplicateReadinessDuringStartupCannotOrphanAProcess() = runBlocking {
        val event = "{\"event\":\"ferretd.ready\",\"endpoint\":\"tcp://127.0.0.1:43123\",\"version\":\"$version\",\"message\":\"ferretd started\"}\n"
        val malformed = "{\"event\":\"ferretd.ready\",\"endpoint\":false}\n"
        for (duplicate in listOf(event, malformed)) {
            val process = FakeDaemonProcess(event + duplicate)
            val fixture = fixture(process)
            try {
                try {
                    val generation = fixture.connection.generation()
                    withTimeout(5_000L) { generation.stopped.await() }
                } catch (_: FerretdConnectionException) {
                    // Readiness can fail before or after the generation is accepted.
                }
                assertTrue(withContext(Dispatchers.IO) { process.waitFor(5, TimeUnit.SECONDS) })
                assertFalse(process.isAlive)
                assertEquals(1, fixture.rpc.calls.count { it == "close" })
            } finally {
                fixture.connection.closeForTest()
                fixture.scope.cancel()
                fixture.root.toFile().deleteRecursively()
            }
        }
    }

    @Test
    fun failedHandshakeCanBeCorrectedAndRetriedWithoutStaleState() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val root = Files.createTempDirectory("ferretd-retry-").toRealPath()
        val processes = List(2) { FakeDaemonProcess.ready(version) }
        val rpcs = processes.map { process -> FakeFerretdRpc(version, root, emptyList(), onShutdown = process::destroy) }
        rpcs.first().getInfoFailure = IllegalStateException("failed authentication")
        val starts = AtomicInteger()
        val launcher = FerretdDaemonLauncher.testing(scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> processes[starts.getAndIncrement()] },
            { _, _ -> rpcs[starts.get() - 1] },
        )
        val connection = FerretdDaemonConnection.testing(scope, launcher)
        try {
            try {
                connection.generation()
                fail("The first handshake must fail")
            } catch (_: FerretdConnectionException) {
                assertFalse(processes.first().isAlive)
            }
            val next = connection.generation()
            assertSame(processes.last(), next.process)
            assertEquals(2, starts.get())
            connection.shutdown()
            assertFalse(processes.last().isAlive)
        } finally {
            connection.closeForTest()
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun malformedReadinessAndExitBeforeReadinessCleanUpWithoutConnecting() = runBlocking {
        val malformed = FakeDaemonProcess("{\"event\":\"ferretd.ready\",\"endpoint\":false}\n")
        val exited = FakeDaemonProcess("").also { it.crash(23) }
        for (process in listOf(malformed, exited)) {
            val fixture = fixture(process)
            try {
                try {
                    fixture.connection.generation()
                    fail("Invalid startup must fail")
                } catch (_: FerretdConnectionException) {
                    assertFalse(process.isAlive)
                    assertTrue(fixture.rpc.calls.isEmpty())
                }
            } finally {
                fixture.connection.closeForTest()
                fixture.scope.cancel()
                fixture.root.toFile().deleteRecursively()
            }
        }
    }

    private fun fixture(process: FakeDaemonProcess = FakeDaemonProcess.ready(version)): Fixture {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val root = Files.createTempDirectory("ferretd-recovery-").toRealPath()
        val rpc = FakeFerretdRpc(version, root, emptyList(), onShutdown = process::destroy)
        val launcher = FerretdDaemonLauncher.testing(scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> process },
            { _, _ -> rpc },
        )
        return Fixture(scope, root, rpc, FerretdDaemonConnection.testing(scope, launcher))
    }

    private data class Fixture(
        val scope: CoroutineScope,
        val root: Path,
        val rpc: FakeFerretdRpc,
        val connection: FerretdDaemonConnection,
    )

    private val version = "1.0.0-alpha.6"
}
