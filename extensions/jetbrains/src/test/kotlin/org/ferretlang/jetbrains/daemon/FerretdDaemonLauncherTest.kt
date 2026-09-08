package org.ferretlang.jetbrains.daemon

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.execution.FakeFerretdRpc
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.execution.FerretdServerInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class FerretdDaemonLauncherTest {
    @Test
    fun readinessErrorsRedactTheGeneratedCredentialBeforeLeavingTheLauncher() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.6"
        var credential = ""
        lateinit var process: FakeDaemonProcess
        val launcher = FerretdDaemonLauncher.testing(scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, token ->
                credential = token
                FakeDaemonProcess.ready(token).also { process = it }
            },
            { _, _ -> error("Invalid readiness must not connect") },
        )
        try {
            val error = assertThrows(FerretdConnectionException::class.java) { runBlocking { launcher.start() } }
            assertTrue(credential.isNotEmpty())
            assertFalse("Readiness error chains must not disclose authentication", error.stackTraceToString().contains(credential))
            assertFalse(process.isAlive)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun launchesWithOneUnpaddedTokenAndAuthenticatedInfo() = runBlocking {
        val root = Files.createTempDirectory("ferretd-launcher-").toRealPath()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.6"
        val process = FakeDaemonProcess.ready(version)
        val rpc = FakeFerretdRpc(version, root, emptyList())
        val starterTokens = mutableListOf<String>()
        val connectorTokens = mutableListOf<String>()
        val launcher = FerretdDaemonLauncher.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { installation, token ->
                assertEquals(Path.of("/installed/ferretd"), installation.executable)
                starterTokens += token
                process
            },
            { port, token ->
                assertEquals(43123, port)
                connectorTokens += token
                rpc
            },
        )
        try {
            val started = launcher.start()
            assertSame(process, started.process)
            assertSame(rpc, started.rpc)
            assertTrue("Startup and authentication must use the same credential", starterTokens == connectorTokens)
            assertEquals(43, starterTokens.single().length)
            assertTrue(starterTokens.single().none { it == '=' })
            assertEquals(listOf("getInfo"), rpc.calls)
            assertFalse(started.lost.isCompleted)
            started.stopping.set(true)
            process.destroy()
            started.stderr.cancel()
            started.stdout.cancel()
            started.processWaiter.cancel()
        } finally {
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun buildsTheAuthenticatedEphemeralLoopbackCommand() {
        val installation = FerretdInstallation(Path.of("/installed/ferretd"), "1.0.0-alpha.6")

        assertEquals(
            listOf(
                installation.executable.toString(),
                "serve",
                "--endpoint",
                "tcp://127.0.0.1:0",
                "--auth-token-env=FERRETD_AUTH_TOKEN",
            ),
            FerretdDaemonLauncher.command(installation),
        )
    }

    @Test
    fun rejectsAuthenticationVersionApiAndInstanceFailuresAndCleansUp() {
        val version = "1.0.0-alpha.6"
        val cases = listOf<(FakeFerretdRpc) -> Unit>(
            { it.getInfoFailure = FerretdRpcException("get-info", "Unauthenticated") },
            { it.serverInfo = FerretdServerInfo("wrong", "instance", 1, 1) },
            { it.serverInfo = FerretdServerInfo(version, "instance", 1, 2) },
            { it.serverInfo = FerretdServerInfo(version, "", 1, 1) },
        )
        cases.forEach { configure ->
            val root = Files.createTempDirectory("ferretd-launcher-failure-").toRealPath()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val rpc = FakeFerretdRpc(version, root, emptyList()).also(configure)
            val process = FakeDaemonProcess.ready(version)
            val launcher = FerretdDaemonLauncher.testing(
                scope,
                { FerretdInstallation(Path.of("/installed/ferretd"), version) },
                { _, _ -> process },
                { _, _ -> rpc },
            )
            try {
                assertThrows(FerretdConnectionException::class.java) {
                    runBlocking { launcher.start() }
                }
                assertFalse(process.isAlive)
                assertEquals(1, rpc.calls.count { it == "close" })
            } finally {
                scope.cancel()
                root.toFile().deleteRecursively()
            }
        }
    }

    @Test
    fun timesOutWithoutReadinessAndNeverConnects() {
        val root = Files.createTempDirectory("ferretd-launcher-timeout-").toRealPath()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.6"
        val rpc = FakeFerretdRpc(version, root, emptyList())
        val process = FakeDaemonProcess("")
        val launcher = FerretdDaemonLauncher.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> process },
            { _, _ -> rpc },
            startupTimeoutMillis = 25L,
        )
        try {
            val error = assertThrows(FerretdConnectionException::class.java) {
                runBlocking { launcher.start() }
            }
            assertTrue(error.message.orEmpty().contains("did not become ready in time"))
            assertTrue(rpc.calls.none { it == "getInfo" })
            assertFalse(process.isAlive)
        } finally {
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun startupCancellationBeforeProcessHandoffCleansUpTheProcess() = runBlocking {
        assertCancellationBeforeProcessHandoffCleansUp(cancelOwningScope = false)
    }

    @Test
    fun scopeCancellationBeforeProcessHandoffCleansUpTheProcess() = runBlocking {
        assertCancellationBeforeProcessHandoffCleansUp(cancelOwningScope = true)
    }

    private suspend fun assertCancellationBeforeProcessHandoffCleansUp(cancelOwningScope: Boolean) {
        val scopeJob = SupervisorJob()
        val scope = CoroutineScope(scopeJob + Dispatchers.Default)
        val version = "1.0.0-alpha.6"
        val process = FakeDaemonProcess("")
        val processStarted = CompletableDeferred<Unit>()
        val returnProcess = CountDownLatch(1)
        val connectorCalls = AtomicInteger()
        val launcher = FerretdDaemonLauncher.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ ->
                processStarted.complete(Unit)
                check(returnProcess.await(5L, TimeUnit.SECONDS)) { "Timed out waiting to return the daemon process." }
                process
            },
            { _, _ ->
                connectorCalls.incrementAndGet()
                error("Cancelled startup must not connect to the daemon.")
            },
        )
        val startup = scope.async { launcher.start() }
        try {
            withTimeout(5_000L) { processStarted.await() }
            if (cancelOwningScope) {
                scope.cancel()
            } else {
                startup.cancel()
            }
            returnProcess.countDown()
            withTimeout(5_000L) { startup.join() }

            assertTrue(startup.isCancelled)
            assertEquals(0, connectorCalls.get())
            assertFalse(process.isAlive)
        } finally {
            returnProcess.countDown()
            scope.cancel()
            process.destroy()
            withTimeout(5_000L) { scopeJob.join() }
        }
    }

    @Test
    fun duplicateReadinessCompletesTheLossSignal() = runBlocking {
        val root = Files.createTempDirectory("ferretd-launcher-duplicate-").toRealPath()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.6"
        val event = "{\"event\":\"ferretd.ready\",\"endpoint\":\"tcp://127.0.0.1:43123\"," +
            "\"version\":\"$version\",\"message\":\"ferretd started\"}\n"
        val process = FakeDaemonProcess(event + event)
        val rpc = FakeFerretdRpc(version, root, emptyList())
        val launcher = FerretdDaemonLauncher.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> process },
            { _, _ -> rpc },
        )
        try {
            val started = launcher.start()
            val loss = withTimeout(5_000L) { started.lost.await() }
            assertTrue(loss.message.orEmpty().contains("more than once"))
            started.stopping.set(true)
            process.destroy()
            started.stderr.cancel()
            started.stdout.cancel()
            started.processWaiter.cancel()
        } finally {
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }
}
