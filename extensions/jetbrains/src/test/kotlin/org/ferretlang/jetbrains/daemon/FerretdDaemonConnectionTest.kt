package org.ferretlang.jetbrains.daemon

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.execution.FakeFerretdRpc
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.execution.FerretdServerInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

class FerretdDaemonConnectionTest {
    @Test
    fun coalescesStartupAndWorkspaceAndUsesOneUnpaddedToken() = runBlocking {
        val root = Files.createTempDirectory("ferretd-connection-").toRealPath()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.5"
        val rpc = FakeFerretdRpc(version, root, emptyList())
        val process = FakeDaemonProcess.ready(version)
        val starts = AtomicInteger()
        val startupTokens = Collections.synchronizedList(mutableListOf<String>())
        val connectorTokens = Collections.synchronizedList(mutableListOf<String>())
        val connection = FerretdDaemonConnection.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, token ->
                starts.incrementAndGet()
                startupTokens += token
                process
            },
            { port, token ->
                assertEquals(43123, port)
                connectorTokens += token
                rpc
            },
        )
        try {
            val generations = List(8) { async { connection.generation() } }.awaitAll()
            assertEquals(1, generations.map { it.number }.distinct().size)
            val workspaces = List(8) { async { connection.workspace(generations.first(), root) } }.awaitAll()
            assertEquals(listOf("workspace"), workspaces.distinct())
            assertEquals(1, starts.get())
            assertEquals(1, rpc.calls.count { it == "getInfo" })
            assertEquals(1, rpc.calls.count { it == "openWorkspace" })
            assertEquals(startupTokens, connectorTokens)
            assertEquals(43, startupTokens.single().length)
            assertTrue(startupTokens.single().none { it == '=' })

            connection.shutdown()
            connection.shutdown()
            assertEquals(1, rpc.calls.count { it == "shutdown" })
        } finally {
            connection.closeForTest()
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun rejectsAuthenticationVersionApiAndInstanceFailures() {
        val cases = listOf<(FakeFerretdRpc) -> Unit>(
            { it.getInfoFailure = FerretdRpcException("get-info", "Unauthenticated") },
            { it.serverInfo = FerretdServerInfo("wrong", "instance", 1, 1) },
            { it.serverInfo = FerretdServerInfo("1.0.0-alpha.5", "instance", 1, 2) },
            { it.serverInfo = FerretdServerInfo("1.0.0-alpha.5", "", 1, 1) },
        )
        cases.forEach { configure ->
            val root = Files.createTempDirectory("ferretd-connection-failure-").toRealPath()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val version = "1.0.0-alpha.5"
            val rpc = FakeFerretdRpc(version, root, emptyList()).also(configure)
            val connection = FerretdDaemonConnection.testing(
                scope,
                { FerretdInstallation(Path.of("/installed/ferretd"), version) },
                { _, _ -> FakeDaemonProcess.ready(version) },
                { _, _ -> rpc },
            )
            try {
                assertThrows(FerretdConnectionException::class.java) {
                    runBlocking { connection.generation() }
                }
            } finally {
                runBlocking { connection.closeForTest() }
                scope.cancel()
                root.toFile().deleteRecursively()
            }
        }
    }

    @Test
    fun invalidatesADeadGenerationAndRestartsOnlyOnTheNextRequest() = runBlocking {
        val root = Files.createTempDirectory("ferretd-generation-").toRealPath()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.5"
        val processes = ArrayDeque(listOf(FakeDaemonProcess.ready(version), FakeDaemonProcess.ready(version)))
        val rpcs = mutableListOf<FakeFerretdRpc>()
        val connection = FerretdDaemonConnection.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> processes.removeFirst() },
            { _, _ -> FakeFerretdRpc(version, root, emptyList()).also(rpcs::add) },
        )
        try {
            val first = connection.generation()
            connection.workspace(first, root)
            first.process.let { it as FakeDaemonProcess }.crash(17)
            withTimeout(5_000L) { first.lost.await() }

            val second = connection.generation()
            assertNotEquals(first.number, second.number)
            connection.workspace(second, root)
            assertEquals(2, rpcs.size)
            assertEquals(1, rpcs[0].calls.count { it == "openWorkspace" })
            assertEquals(1, rpcs[1].calls.count { it == "openWorkspace" })
        } finally {
            connection.closeForTest()
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun failsStartupWhenNoReadyEventArrives() {
        val root = Files.createTempDirectory("ferretd-timeout-").toRealPath()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.5"
        val rpc = FakeFerretdRpc(version, root, emptyList())
        val connection = FerretdDaemonConnection.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> FakeDaemonProcess("") },
            { _, _ -> rpc },
            startupTimeoutMillis = 25L,
        )
        try {
            val error = assertThrows(FerretdConnectionException::class.java) {
                runBlocking { connection.generation() }
            }
            assertTrue(error.message.orEmpty().contains("failed during startup"))
            assertTrue(rpc.calls.none { it == "getInfo" })
        } finally {
            runBlocking { connection.closeForTest() }
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }
}
