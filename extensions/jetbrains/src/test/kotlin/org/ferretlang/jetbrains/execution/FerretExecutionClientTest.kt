package org.ferretlang.jetbrains.execution

import com.intellij.execution.ExecutionException
import org.ferretlang.jetbrains.runtime.CatalogStatus
import org.ferretlang.jetbrains.runtime.FerretRuntimeCatalog
import org.ferretlang.jetbrains.runtime.FerretRuntimeDescriptor
import org.junit.Assert.assertThrows
import org.ferretlang.jetbrains.launch.FerretLaunchInput

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.daemon.FerretdConnectionException
import org.ferretlang.jetbrains.daemon.FerretdDaemonLauncher
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class FerretExecutionClientTest {
    @Test
    fun reloadRefusesDuringCancellationUntilSessionCleanupFinishes() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.WAIT_FOR_CANCELLATION)
        val gate = CompletableDeferred<Unit>()
        fixture.rpc.closeSessionGate = gate
        try {
            val execution = fixture.execute()
            execution.awaitStarted()
            fixture.connection.applyConfigPath("next.json")
            execution.handle.cancel()
            fixture.rpc.closeSessionEntered.awaitResult()
            org.junit.Assert.assertThrows(com.intellij.execution.ExecutionException::class.java) {
                fixture.connection.reloadRuntimes()
            }
            gate.complete(Unit)
            assertEquals(130, execution.exit.awaitResult())
            assertFalse(fixture.connection.catalogState.value.busy)
            assertEquals(org.ferretlang.jetbrains.runtime.CatalogStatus.RELOAD_REQUIRED, fixture.connection.catalogState.value.status)
        } finally {
            gate.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun bindsExactSelectorsAndPreservesWireOptionsAcrossSnapshots() = runBlocking {
        val fixture = fixture(*Array(4) { FakeFerretdRpc.Outcome.COMPLETED })
        try {
            fixture.configureWire()
            fixture.connection.ensureCatalog()!!.join()
            for ((selector, directory) in listOf("" to " ", "WireApp" to " relative/../app ", "WireApp" to """C:\service\data""", "local" to "")) {
                val run = fixture.execute(workingDirectory = directory, runtimeName = selector)
                assertEquals(0, run.exit.awaitResult())
                assertEquals(directory.takeUnless(String::isBlank), fixture.rpc.requestedExecutionOptions.last().workingDirectory)
                val target = if (selector == "local") "'local' (native)" else "'WireApp' (wire)"
                assertTrue(run.system.contains("Preparing Ferret runtime $target."))
            }
            assertEquals(listOf("", "WireApp", "WireApp", "local"), fixture.rpc.requestedRuntimeNames.toList())
            assertEquals(1, fixture.rpc.calls.count { it == "getInfo" })
            assertEquals(1, fixture.rpc.calls.count { it == "listRuntimes" })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun missingUnsupportedAndMisacknowledgedRuntimesCannotStartExecutions() = runBlocking {
        val fixture = fixture()
        try {
            fixture.configureWire()
            for ((name, message) in listOf("wireapp" to "unavailable", "Unknown" to "Unsupported Ferret runtime provider")) {
                val run = fixture.execute(runtimeName = name)
                assertEquals(1, run.exit.awaitResult())
                assertTrue(run.stderr.single(), run.stderr.single().contains(message))
            }
            assertTrue(fixture.rpc.requestedRuntimeNames.isEmpty())
            for ((selector, ack) in listOf("WireApp" to "", "" to "local", "local" to "WireApp", "" to "absent")) {
                fixture.rpc.sessionRuntime = { ack }
                val run = fixture.execute(runtimeName = selector)
                assertEquals(1, run.exit.awaitResult())
                assertTrue(run.stderr.single(), run.stderr.single().contains("acknowledged"))
            }
            assertEquals(listOf("WireApp", "", "local", ""), fixture.rpc.requestedRuntimeNames.toList())
            assertEquals((1..4).map { "closeSession:session-$it" }, fixture.rpc.calls.filter { it.startsWith("closeSession:") })
            assertTrue(fixture.rpc.calls.none { it.startsWith("createExecution:") })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun olderDaemonSupportsOnlyTheUnconfiguredDefault() = runBlocking {
        for ((minor, path, name) in listOf(Triple(1, false, ""), Triple(2, false, ""), Triple(1, false, "local"),
            Triple(2, true, ""), Triple(2, false, "WireApp"))) {
            val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
            try {
                if (path) fixture.connection.applyConfigPath(Files.createFile(fixture.root.resolve("config.json")).toString())
                fixture.rpc.serverInfo = fixture.rpc.serverInfo.copy(apiMinor = minor)
                val run = fixture.execute(runtimeName = name)
                if (!path && name.isEmpty()) {
                    assertEquals(0, run.exit.awaitResult())
                    assertEquals(listOf(""), fixture.rpc.requestedRuntimeNames.toList())
                } else {
                    assertEquals(1, run.exit.awaitResult())
                    assertTrue(run.stderr.single().contains("requires Ferret daemon API 1.3"))
                    assertTrue(fixture.rpc.requestedRuntimeNames.isEmpty())
                }
                assertFalse(fixture.rpc.calls.contains("listRuntimes"))
            } finally {
                fixture.close()
            }
        }
    }

    @Test
    fun applyDuringCatalogLookupPreservesTheAdmittedDefault(): Unit = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val entered = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        try {
            fixture.configureWire()
            val discover = fixture.rpc.discover
            fixture.rpc.discover = { entered.complete(Unit); proceed.await(); discover() }
            val ui = fixture.connection.ensureCatalog()!!
            entered.awaitResult()
            val admitted = fixture.execute(workingDirectory = "remote/only")
            fixture.connection.applyConfigPath("replacement.json")
            assertEquals(CatalogStatus.RELOAD_REQUIRED, fixture.connection.catalogState.value.status)
            assertEquals(null, fixture.connection.catalogState.value.catalog)
            val error = assertThrows(ExecutionException::class.java) { fixture.execute(runtimeName = "local") }
            assertTrue(error.message.orEmpty().contains("Reload"))
            assertFalse(error.message.orEmpty().contains("clear"))
            assertThrows(ExecutionException::class.java) { fixture.connection.reloadRuntimes() }
            proceed.complete(Unit)
            ui.join()
            assertEquals(0, admitted.exit.awaitResult())
            assertEquals(listOf(""), fixture.rpc.requestedRuntimeNames.toList())
            assertTrue(admitted.system.contains("Preparing Ferret runtime 'WireApp' (wire)."))
            assertEquals(1, fixture.rpc.calls.count { it == "listRuntimes" })
            assertEquals(CatalogStatus.RELOAD_REQUIRED, fixture.connection.catalogState.value.status)
            assertThrows(ExecutionException::class.java) { fixture.execute() }
        } finally {
            proceed.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun ordersRpcCallsRegistersWatchEagerlyAndRendersTerminalJson() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        try {
            val execution = fixture.execute()
            assertEquals(0, execution.exit.awaitResult())
            assertTrue(execution.stdout.single().contains("\"id\": \"execution-1\""))
            assertEquals(
                FerretdExecutionOptions("application/json", fixture.root.toRealPath().toString()),
                fixture.rpc.requestedExecutionOptions.single(),
            )
            assertTrue(execution.debug.any { it == "Workspace root: ${fixture.root.toRealPath()}" })
            assertTrue(execution.debug.any { it == "Working directory: ${fixture.root.toRealPath()}" })
            assertEquals(listOf("Preparing Ferret runtime 'local' (native).", "Ferret execution completed."), execution.system.toList())
            assertEquals(listOf("output", "terminated:0"), execution.events.toList())
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
    fun completesWithAbsentEmptyAndUntypedOutput() = runBlocking {
        val raw = """{"raw":1}"""
        val cases = listOf(
            null to emptyList(),
            FerretdExecutionOutput("application/json", ByteArray(0)) to emptyList(),
            FerretdExecutionOutput("", ByteArray(0)) to emptyList(),
            FerretdExecutionOutput("", raw.toByteArray()) to listOf(raw),
        )
        for ((output, expected) in cases) {
            val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
            try {
                fixture.rpc.terminalSnapshot = { it.copy(output = output) }
                val execution = fixture.execute()
                assertEquals(0, execution.exit.awaitResult())
                assertEquals(expected, execution.stdout.toList())
                assertTrue(execution.stderr.isEmpty())
                assertTrue(execution.system.contains("Ferret execution completed."))
            } finally {
                fixture.close()
            }
        }
    }

    @Test
    fun reportsRuntimeAcquisitionErrorInTheRunConsole() = runBlocking {
        val fixture = fixture()
        try {
            val message = "Ferret runtime is unavailable: worker timed out"
            fixture.rpc.createSessionFailure = FerretdRpcException("create-session", message)
            val execution = fixture.execute()
            assertEquals(1, execution.exit.awaitResult())
            assertEquals(listOf(message), execution.stderr.toList())
            assertTrue(execution.stdout.isEmpty())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun reportsFailureAndDiagnosticWithRetainedPartialJson() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val partial = """{"prefix":"""
        val position = FerretdPosition(1, 2)
        val diagnostic = FerretdDiagnostic(
            "file:///query.fql", FerretdRange(position, position), "E1", "ferret", "invalid expression", emptyList(),
        )
        try {
            fixture.rpc.terminalSnapshot = {
                it.copy(
                    state = FerretdExecutionState.FAILED,
                    output = FerretdExecutionOutput("application/json", partial.toByteArray()),
                    failure = FerretdFailure(FerretdFailureCategory.RUNTIME, "runtime failed", listOf(diagnostic)),
                )
            }
            val execution = fixture.execute()
            assertEquals(1, execution.exit.awaitResult())
            assertEquals("runtime failed", execution.stderr.first())
            assertTrue(execution.stderr.contains("invalid expression"))
            assertTrue(execution.system.contains("Partial output:"))
            assertFalse(execution.system.contains("Ferret execution completed."))
            assertEquals(listOf(partial), execution.stdout.toList())
            assertTrue(execution.internal.isEmpty())
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
            assertTrue(first.internal.toList().isEmpty())
            assertTrue(second.internal.toList().isEmpty())
            assertEquals(listOf("terminated:130"), first.events.toList())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun stopBeforeExecutionIdAbortsSetupAndClosesTheSession() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val gate = CompletableDeferred<Unit>()
        val cleanup = CompletableDeferred<Unit>()
        fixture.configureWire()
        fixture.rpc.closeSessionGate = cleanup
        fixture.rpc.createSessionGate = gate
        try {
            val execution = fixture.execute()
            fixture.rpc.createSessionEntered.awaitResult()
            assertTrue(execution.handle.cancel())
            assertFalse(execution.exit.isCompleted)
            assertThrows(ExecutionException::class.java) { fixture.connection.reloadRuntimes() }
            gate.complete(Unit)
            fixture.rpc.closeSessionEntered.awaitResult()
            assertThrows(ExecutionException::class.java) { fixture.connection.reloadRuntimes() }
            assertFalse(execution.exit.isCompleted)
            cleanup.complete(Unit)

            assertEquals(130, execution.exit.awaitResult())
            assertTrue(fixture.rpc.calls.none { it.startsWith("createExecution:") })
            assertTrue(fixture.rpc.calls.none { it.startsWith("closeExecution:") })
            assertTrue(fixture.rpc.calls.any { it == "closeSession:session-1" })
        } finally {
            gate.complete(Unit)
            cleanup.complete(Unit)
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
            fixture.rpc.runExecutionEntered.awaitResult()
            assertTrue(execution.handle.cancel())
            fixture.rpc.cancellationEntered.awaitResult()

            assertEquals(130, execution.exit.awaitResult())
            assertEquals(1, fixture.rpc.calls.count { it == "cancelExecution:execution-1" })
            assertTrue(execution.internal.toList().isEmpty())
        } finally {
            gate.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun acceptsAnAlreadyCompletedCancellationResponseBeforeTheResultIsCommitted() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val gate = CompletableDeferred<Unit>()
        fixture.rpc.terminalGate = gate
        try {
            val execution = fixture.execute()
            fixture.rpc.terminalEntered.awaitResult()
            assertTrue(execution.handle.cancel())
            assertEquals(130, execution.exit.awaitResult())
            assertEquals(1, fixture.rpc.calls.count { it == "cancelExecution:execution-1" })
            assertTrue(execution.internal.toList().isEmpty())
            assertTrue(execution.stdout.toList().isEmpty())
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

    @Test
    fun omitsBlankWorkingDirectoryAndShowsTheWorkspaceDefault() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        try {
            val execution = fixture.execute(workingDirectory = "")
            assertEquals(0, execution.exit.awaitResult())
            assertEquals(null, fixture.rpc.requestedExecutionOptions.single().workingDirectory)
            assertTrue(
                execution.debug.any {
                    it == "Working directory: ${fixture.root.toRealPath()} (daemon default)"
                },
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun rejectsMismatchedSnapshotOptions() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        fixture.rpc.executionOptionsOverride = FerretdExecutionOptions("application/json", null)
        try {
            val execution = fixture.execute()
            assertEquals(1, execution.exit.awaitResult())
            assertTrue(execution.stderr.any { it.contains("contradictory execution snapshot") })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun concurrentRunsKeepDistinctWorkingDirectories() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED, FakeFerretdRpc.Outcome.COMPLETED)
        val firstRoot = Files.createTempDirectory("ferret-runtime-first-")
        val secondRoot = Files.createTempDirectory("ferret-runtime-second-")
        try {
            val first = fixture.execute("first.fql", firstRoot.toString())
            val second = fixture.execute("second.fql", secondRoot.toString())
            assertEquals(0, first.exit.awaitResult())
            assertEquals(0, second.exit.awaitResult())
            assertEquals(
                setOf(firstRoot.toRealPath().toString(), secondRoot.toRealPath().toString()),
                fixture.rpc.requestedExecutionOptions.mapNotNull { it.workingDirectory }.toSet(),
            )
        } finally {
            fixture.close()
            firstRoot.toFile().deleteRecursively()
            secondRoot.toFile().deleteRecursively()
        }
    }

    @Test
    fun stopDuringSharedStartupLeavesItAvailableForTheNextRun() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val gate = CompletableDeferred<Unit>()
        fixture.rpc.getInfoGate = gate
        try {
            val first = fixture.execute()
            fixture.rpc.getInfoEntered.awaitResult()
            first.handle.cancel()
            assertEquals(130, first.exit.awaitResult())
            assertTrue(fixture.rpc.calls.none { it.startsWith("createSession:") })
            val second = fixture.execute("second.fql")
            gate.complete(Unit)
            assertEquals(0, second.exit.awaitResult())
            assertEquals(1, fixture.rpc.calls.count { it == "getInfo" })
            assertEquals(1, fixture.rpc.calls.count { it == "openWorkspace" })
        } finally {
            gate.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun daemonLossDuringCatalogLookupFailsTheAdmittedRun() = runBlocking {
        val fixture = fixture()
        val entered = CompletableDeferred<Unit>()
        try {
            fixture.configureWire()
            fixture.rpc.discover = { entered.complete(Unit); awaitCancellation() }
            val run = fixture.execute()
            entered.awaitResult()
            fixture.assertCrashFailsPreparation(run)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun daemonLossDuringWorkspaceOpenFailsTheAdmittedRun() = runBlocking {
        val fixture = fixture()
        try {
            fixture.rpc.workspaceGate = CompletableDeferred()
            val run = fixture.execute()
            fixture.rpc.workspaceEntered.awaitResult()
            fixture.assertCrashFailsPreparation(run)
        } finally {
            fixture.close()
        }
    }

    private suspend fun Fixture.assertCrashFailsPreparation(run: RecordingSink) {
        (connection.generation().process as FakeDaemonProcess).crash(7)
        assertEquals(1, run.exit.awaitResult())
        assertTrue(run.stderr.single().contains("exited unexpectedly with code 7"))
        assertEquals(1, rpc.calls.count { it == "getInfo" })
        assertTrue(rpc.requestedRuntimeNames.isEmpty())
        assertFalse(connection.catalogState.value.busy)
    }

    @Test
    fun stopDuringSharedCatalogLookupLeavesItAvailableForAnotherRun() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val entered = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        try {
            fixture.configureWire()
            val discover = fixture.rpc.discover
            fixture.rpc.discover = { entered.complete(Unit); proceed.await(); discover() }
            val stopped = fixture.execute()
            entered.awaitResult()
            val continuing = fixture.execute("second.fql", runtimeName = "WireApp")
            stopped.handle.cancel()
            assertEquals(130, stopped.exit.awaitResult())
            assertTrue(stopped.stderr.isEmpty())
            proceed.complete(Unit)
            assertEquals(0, continuing.exit.awaitResult())
            assertEquals(1, fixture.rpc.calls.count { it == "listRuntimes" })
            assertEquals(listOf("WireApp"), fixture.rpc.requestedRuntimeNames.toList())
        } finally {
            proceed.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun stopDuringSharedWorkspaceOpenDoesNotDiscardItsResult() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        val gate = CompletableDeferred<Unit>()
        fixture.rpc.workspaceGate = gate
        try {
            val first = fixture.execute()
            fixture.rpc.workspaceEntered.awaitResult()
            first.handle.cancel()
            assertEquals(130, first.exit.awaitResult())
            val second = fixture.execute("second.fql")
            gate.complete(Unit)
            assertEquals(0, second.exit.awaitResult())
            assertEquals(1, fixture.rpc.calls.count { it == "openWorkspace" })
        } finally {
            gate.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun projectDisposalDuringAcquisitionReleasesLaunchAfterSettlement() = runBlocking {
        val fixture = fixture()
        val reply = CompletableDeferred<Unit>()
        fixture.configureWire()
        fixture.rpc.createSessionGate = reply
        try {
            val run = fixture.execute()
            fixture.rpc.createSessionEntered.awaitResult()
            fixture.scope.cancel()
            assertTrue(fixture.connection.catalogState.value.busy)
            reply.complete(Unit)
            assertEquals(130, run.exit.awaitResult())
            assertFalse(fixture.connection.catalogState.value.busy)
            assertTrue(fixture.rpc.calls.none { it.startsWith("createExecution:") })
            withTimeout(5_000) { fixture.scope.coroutineContext[kotlinx.coroutines.Job]!!.join() }
        } finally {
            reply.complete(Unit)
            fixture.close()
        }
    }

    @Test
    fun projectScopeCancellationTerminatesAnActiveRunAndReleasesItsDaemon() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.WAIT_FOR_CANCELLATION)
        try {
            val execution = fixture.execute()
            execution.awaitStarted()
            val generation = fixture.connection.generation()
            fixture.scope.cancel()
            assertEquals(130, execution.exit.awaitResult())
            withTimeout(5_000L) { fixture.scope.coroutineContext[kotlinx.coroutines.Job]!!.join() }
            assertFalse(generation.process.isAlive)
            assertEquals(listOf("terminated:130"), execution.events.toList())
            assertTrue(execution.stderr.toList().isEmpty())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun cancelledScopeStillTerminatesARunThatNeverStarts() = runBlocking {
        val fixture = fixture(FakeFerretdRpc.Outcome.COMPLETED)
        try {
            fixture.scope.cancel()
            val execution = fixture.execute()
            assertEquals(130, execution.exit.awaitResult())
            assertEquals(listOf("terminated:130"), execution.events.toList())
            assertTrue(fixture.rpc.calls.isEmpty())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun projectCancellationWinsDaemonLossBeforeCancellationReachesTheRun() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val cancellationEntered = CountDownLatch(1)
        val cancellationGate = CountDownLatch(1)
        // Hold cancellation propagation at the first child. The project is
        // already cancelled while the connection and run can still observe loss.
        scope.launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                cancellationEntered.countDown()
                check(cancellationGate.await(5, TimeUnit.SECONDS))
            }
        }
        val fixture = fixture(FakeFerretdRpc.Outcome.WAIT_FOR_CANCELLATION, scope = scope)
        try {
            val execution = fixture.execute()
            execution.awaitStarted()
            val generation = fixture.connection.generation()
            val cancelling = async(Dispatchers.IO) { scope.cancel() }
            try {
                assertTrue(withContext(Dispatchers.IO) { cancellationEntered.await(5, TimeUnit.SECONDS) })
                generation.lost.complete(FerretdConnectionException("The daemon stopped during project disposal."))
                assertEquals(130, execution.exit.awaitResult())
                assertFalse("Cancellation must still be held before reaching the run", cancelling.isCompleted)
                assertEquals(listOf("terminated:130"), execution.events.toList())
                assertTrue(execution.stderr.toList().isEmpty())
            } finally {
                cancellationGate.countDown()
                cancelling.await()
            }
            withTimeout(5_000L) { scope.coroutineContext[kotlinx.coroutines.Job]!!.join() }
            assertFalse(generation.process.isAlive)
        } finally {
            cancellationGate.countDown()
            fixture.close()
        }
    }

    @Test
    fun completionAndImmediateStopTerminateExactlyOnce() = runBlocking {
        val fixture = fixture(*Array(20) { FakeFerretdRpc.Outcome.COMPLETED })
        try {
            repeat(20) {
                val execution = fixture.execute("race-$it.fql")
                execution.handle.cancel()
                val code = execution.exit.awaitResult()
                assertTrue(code == 0 || code == 130)
                assertFalse(execution.handle.cancel())
                assertEquals(1, execution.events.count { it.startsWith("terminated:") })
                assertTrue(execution.internal.toList().isEmpty())
            }
        } finally {
            fixture.close()
        }
    }

    private fun fixture(
        vararg outcomes: FakeFerretdRpc.Outcome,
        scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    ): Fixture {
        val root = Files.createTempDirectory("ferret-client-test-")
        val version = "1.0.0-alpha.6"
        val process = FakeDaemonProcess.ready(version)
        val rpc = FakeFerretdRpc(version, root, outcomes.toList(), onShutdown = process::destroy)
        val launcher = FerretdDaemonLauncher.testing(
            scope,
            { FerretdInstallation(Path.of("/installed/ferretd"), version) },
            { _, token, _ ->
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
        val connection = FerretdDaemonConnection.testing(scope, launcher)
        return Fixture(root, scope, rpc, connection)
    }

    private data class Fixture(
        val root: Path,
        val scope: CoroutineScope,
        val rpc: FakeFerretdRpc,
        val connection: FerretdDaemonConnection,
    ) {
        fun configureWire() {
            connection.applyConfigPath(Files.createFile(root.resolve("application.json")).toString())
            rpc.serverInfo = rpc.serverInfo.copy(apiMinor = 4)
            rpc.discover = {
                FerretRuntimeCatalog("WireApp", listOf(
                    FerretRuntimeDescriptor("local", "Built-in", "native"),
                    FerretRuntimeDescriptor("WireApp", "Application", "wire"),
                    FerretRuntimeDescriptor("Unknown", "Other provider", "future"),
                ))
            }
            rpc.sessionRuntime = { it.ifEmpty { "WireApp" } }
        }

        fun execute(
            relativePath: String = "main.fql",
            workingDirectory: String = root.toString(),
            runtimeName: String = "",
        ): RecordingSink {
            val source = Files.writeString(root.resolve(relativePath), "RETURN 1")
            val sink = RecordingSink()
            sink.handle = FerretExecutionClient(connection).start(
                FerretLaunchInput(
                    source.toString(),
                    workingDirectory,
                    null,
                    FerretParameterBindings.EMPTY,
                    runtimeName,
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
        val started = CompletableDeferred<Unit>()
        val debug = Collections.synchronizedList(mutableListOf<String>())
        val internal = Collections.synchronizedList(mutableListOf<String>())
        val events = Collections.synchronizedList(mutableListOf<String>())
        val system = Collections.synchronizedList(mutableListOf<String>())
        val stdout = Collections.synchronizedList(mutableListOf<String>())
        val stderr = Collections.synchronizedList(mutableListOf<String>())
        val exit = CompletableDeferred<Int>()
        lateinit var handle: FerretExecutionHandle

        override fun started() { started.complete(Unit) }

        override fun debug(message: String) { debug += message }

        override fun system(message: String) {
            system += message
        }

        override fun stdout(message: String) {
            stdout += message
            events += "output"
        }

        override fun stderr(message: String) {
            stderr += message
        }

        override fun internal(message: String, cause: Throwable?) { internal += message }

        override fun terminate(exitCode: Int) {
            events += "terminated:$exitCode"
            exit.complete(exitCode)
        }

        suspend fun awaitStarted() {
            withTimeout(5_000L) { started.await() }
        }
    }

    private suspend fun <T> CompletableDeferred<T>.awaitResult(): T = withTimeout(5_000L) { await() }
}
