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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
        val version = "1.0.0-alpha.6"
        val process = FakeDaemonProcess.ready(version)
        val rpc = FakeFerretdRpc(version, root, emptyList(), onShutdown = process::destroy)
        val starts = AtomicInteger()
        val startupTokens = Collections.synchronizedList(mutableListOf<String>())
        val connectorTokens = Collections.synchronizedList(mutableListOf<String>())
        val launcher = FerretdDaemonLauncher.testing(
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
        val connection = FerretdDaemonConnection.testing(scope, launcher)
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
            assertFalse(process.isAlive)
        } finally {
            connection.closeForTest()
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun invalidatesADeadGenerationAndRestartsOnlyOnTheNextRequest() = runBlocking {
        val root = Files.createTempDirectory("ferretd-generation-").toRealPath()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0-alpha.6"
        val daemons = ArrayDeque(List(2) {
            val process = FakeDaemonProcess.ready(version)
            process to FakeFerretdRpc(version, root, emptyList(), onShutdown = process::destroy)
        })
        val rpcs = mutableListOf<FakeFerretdRpc>()
        val launcher = FerretdDaemonLauncher.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> daemons.first().first },
            { _, _ -> daemons.removeFirst().second.also(rpcs::add) },
        )
        val connection = FerretdDaemonConnection.testing(scope, launcher)
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

            connection.shutdown()
            assertFalse(second.process.isAlive)
            assertEquals(1, rpcs[1].calls.count { it == "shutdown" })
        } finally {
            connection.closeForTest()
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test(timeout = 15_000L)
    fun destroysProcessWhenGracefulShutdownDoesNotStopIt() = runBlocking {
        val root = Files.createTempDirectory("ferretd-shutdown-").toRealPath()
        val scopeJob = SupervisorJob()
        val scope = CoroutineScope(scopeJob + Dispatchers.Default)
        val version = "1.0.0-alpha.6"
        val process = FakeDaemonProcess.ready(version)
        val rpc = FakeFerretdRpc(version, root, emptyList())
        val launcher = FerretdDaemonLauncher.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, _ -> process },
            { _, _ -> rpc },
        )
        val connection = FerretdDaemonConnection.testing(scope, launcher)
        try {
            val generation = withTimeout(5_000L) { connection.generation() }
            assertTrue(process.isAlive)

            withTimeout(10_000L) { connection.shutdown() }

            assertFalse(process.isAlive)
            assertTrue(generation.lost.isCompleted)
            assertEquals(1, process.destroyCalls.get())
            withTimeout(5_000L) { connection.shutdown() }
            assertEquals(1, process.destroyCalls.get())
            assertEquals(1, rpc.calls.count { it == "shutdown" })
            assertEquals(1, rpc.calls.count { it == "close" })
        } finally {
            process.destroy()
            try {
                withTimeout(5_000L) { connection.closeForTest() }
            } finally {
                scope.cancel()
                try {
                    withTimeout(5_000L) { scopeJob.join() }
                } finally {
                    root.toFile().deleteRecursively()
                }
            }
        }
    }

}
