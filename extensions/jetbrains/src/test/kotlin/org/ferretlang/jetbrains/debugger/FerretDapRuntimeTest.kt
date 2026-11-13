package org.ferretlang.jetbrains.debugger

import com.google.gson.JsonNull
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.future.await
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.eclipse.lsp4j.debug.Capabilities
import org.eclipse.lsp4j.debug.ExitedEventArguments
import org.eclipse.lsp4j.debug.OutputEventArguments
import org.eclipse.lsp4j.debug.TerminatedEventArguments
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.eclipse.lsp4j.jsonrpc.messages.ResponseError
import org.eclipse.lsp4j.jsonrpc.messages.ResponseErrorCode
import org.ferretlang.jetbrains.runtime.FerretDebugRuntime
import org.ferretlang.jetbrains.runtime.FerretRuntimeDescriptor
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger

class FerretDapRuntimeTest {
    private val file = Path.of("runtime config.json").toAbsolutePath()
    private val runtime = FerretDebugRuntime(FerretRuntimeDescriptor(" 服務 App ", "App", "wire"), file) {}

    @Test fun capabilityMustBeBooleanTrueBeforeAnyRuntimeAwareLaunch() = runBlocking {
        for ((selector, configured) in listOf("local" to false, "" to true, runtime.descriptor.name to true)) {
            for (value in listOf(null, JsonNull.INSTANCE, false, "true", 1)) {
                val launch = DapTestLaunch(runtimeName = selector, prepareRuntime = { if (configured) runtime else FerretDebugRuntime.LOCAL })
                try {
                    launch.responses(value, null)
                    launch.start()
                    assertEquals(1, withTimeout(5000) { launch.session.completion.await() })
                    assertEquals(listOf("initialize", "disconnect"), launch.adapter.history.toList())
                } finally { launch.close() }
            }
        }
    }

    @Test fun missingOrFalseCapabilityAllowsOnlyTheLegacyDefault() = runBlocking {
        for (capability in listOf(null, false)) {
            val launch = DapTestLaunch()
            try {
                launch.responses(capability, null)
                launch.start()
                withTimeout(5000) { launch.session.launchCompleted.await() }
                assertFalse(launch.adapter.launched.await().containsKey("runtimeName"))
            } finally { launch.close() }
        }
    }

    @Test fun selectionAndProviderPathsSurviveTheTransport() = runBlocking {
        for ((selector, directory) in listOf("" to " \t ", "" to "relative/資料", runtime.descriptor.name to " C:\\資料\\α ")) {
            val launch = DapTestLaunch(runtimeName = selector, workingDirectory = directory, prepareRuntime = { runtime })
            try {
                launch.responses(true, mapOf("runtimeName" to runtime.descriptor.name))
                launch.start()
                withTimeout(5000) { launch.session.launchCompleted.await() }
                assertEquals(listOf("--runtime-config", file.toString()), launch.command.takeLast(2))
                val arguments = launch.adapter.launched.await()
                assertEquals(selector.takeUnless(String::isEmpty), arguments["runtimeName"])
                assertEquals(directory.takeUnless(String::isBlank), arguments["workingDirectory"])
                assertEquals(launch.root.toRealPath().toString(), arguments["cwd"])
                assertEquals(launch.source.toRealPath().toString(), arguments["program"])
                assertFalse(arguments.containsKey("runtimeConfig"))
            } finally { launch.close() }
        }
        val native = DapTestLaunch(workingDirectory = ".")
        try {
            native.responses(true, mapOf("runtimeName" to "local"))
            native.start()
            withTimeout(5000) { native.session.launchCompleted.await() }
            assertEquals(native.root.toRealPath().toString(), native.adapter.launched.await()["workingDirectory"])
            assertEquals(listOf(native.source.toString(), "dap"), native.command)
        } finally { native.close() }
    }

    @Test fun invalidAcknowledgmentRejectsEvenAnEarlyStopAndSuccessfulExit() = runBlocking {
        for (ack in listOf(null, "local", emptyMap<String, String>(), mapOf("runtimeName" to 1),
            mapOf("runtimeName" to "LOCAL"), mapOf("runtimeName" to true))) {
            val launch = DapTestLaunch()
            try {
                launch.responses(true, ack)
                launch.adapter.autoConfigure = false
                launch.start()
                withTimeout(5000) {
                    launch.adapter.configurationRequested.await()
                    launch.adapter.configurationResponse.complete(null)
                    launch.adapter.stop()
                    launch.adapter.client.exited(ExitedEventArguments().apply { exitCode = 0 })
                    launch.adapter.client.terminated(TerminatedEventArguments())
                    launch.adapter.launchResponse.complete(null)
                    assertEquals(1, launch.session.completion.await())
                }
                assertTrue(launch.listener.stops.tryReceive().isFailure)
                assertFalse(launch.session.canPerformCommands())
                assertTrue(launch.session.launchCompleted.isCancelled)
                assertTrue(launch.listener.errors.receive().contains("expected runtime"))
                assertEquals(listOf("terminate", "disconnect"), launch.adapter.history.takeLast(2))
            } finally { launch.close() }
        }
    }

    @Test fun earlyStopBecomesInspectableAfterValidatedStartup() = runBlocking {
        val launch = DapTestLaunch()
        try {
            launch.responses(true, mapOf("runtimeName" to "local"))
            launch.adapter.autoConfigure = false
            launch.start()
            withTimeout(5000) {
                launch.adapter.configurationRequested.await()
                launch.adapter.stop()
                launch.adapter.configurationResponse.complete(null)
                launch.adapter.launchResponse.complete(null)
                val stop = launch.listener.stops.receive()
                assertTrue(launch.session.isCurrentStop(stop))
                assertTrue(launch.session.ready)
            }
        } finally { launch.close() }
    }

    @Test fun stopDuringPendingRuntimeAcquisitionEndsOnlyItsAdapter() = runBlocking {
        val pending = DapTestLaunch(runtimeName = runtime.descriptor.name, prepareRuntime = { runtime })
        val sibling = DapTestLaunch()
        try {
            pending.responses(true, mapOf("runtimeName" to runtime.descriptor.name))
            pending.adapter.sendInitialized = false
            pending.start()
            sibling.start()
            withTimeout(5000) {
                pending.adapter.launched.await()
                sibling.session.launchCompleted.await()
                pending.session.stop()
                assertEquals(130, pending.session.completion.await())
                assertEquals(listOf("initialize", "launch", "terminate", "disconnect"), pending.adapter.history.toList())
                assertFalse(pending.process.isAlive)
                sibling.adapter.stop()
                assertTrue(sibling.session.isCurrentStop(sibling.listener.stops.receive()))
            }
        } finally { pending.close(); sibling.close() }
    }

    @Test fun stopAndTimeoutDetachOnlyThisCatalogWaiter() = runBlocking {
        for (stop in listOf(true, false)) {
            val entered = CompletableDeferred<Unit>()
            val shared = CompletableDeferred<FerretDebugRuntime>()
            val launch = DapTestLaunch(timeouts = FerretDapTimeouts(if (stop) 5000 else 300, 2000, 100),
                prepareRuntime = { entered.complete(Unit); shared.await() })
            try {
                launch.start()
                withTimeout(5000) {
                    entered.await()
                    if (stop) launch.session.stop()
                    assertEquals(if (stop) 130 else 1, launch.session.completion.await())
                }
                assertTrue(shared.isActive)
                assertTrue(launch.adapter.history.isEmpty())
            } finally { shared.complete(FerretDebugRuntime.LOCAL); launch.close() }
        }
    }

    @Test fun duplicateAdapterFailuresAndLateInitializeCannotLaunchDuringTheRecheck() = runBlocking {
        val checking = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        val configured = FerretDebugRuntime(runtime.descriptor, file) {
            if (calls.incrementAndGet() > 1) {
                checking.complete(Unit)
                release.await()
            }
        }
        val launch = DapTestLaunch(prepareRuntime = { configured })
        try {
            launch.responses(true, mapOf("runtimeName" to configured.descriptor.name))
            launch.adapter.autoInitialize = false
            launch.start()
            withTimeout(5000) {
                launch.adapter.initialized.await()
                launch.process.unsolicitedResponse()
                checking.await()
                launch.process.unsolicitedResponse()
                launch.adapter.initializeResponse.complete(Capabilities())
                // Output is an ordered barrier after the duplicate failure and the valid late reply.
                launch.adapter.client.output(OutputEventArguments().apply { output = "barrier" })
                launch.listener.output.receive()
                release.complete(Unit)
                assertEquals(1, launch.session.completion.await())
            }
            assertEquals(2, calls.get())
            assertEquals("The Ferret debug adapter connection failed.", launch.listener.errors.receive())
            assertTrue(launch.listener.errors.tryReceive().isFailure)
            assertEquals(listOf("initialize", "disconnect"), launch.adapter.history.toList())
        } finally { release.complete(Unit); launch.close() }
    }

    @Test fun stopAndStartupDeadlineInterruptAnInitializeFailureRecheck() = runBlocking {
        for (stop in listOf(true, false)) {
            val checking = CompletableDeferred<Unit>()
            val cancelled = CompletableDeferred<Unit>()
            val calls = AtomicInteger()
            val configured = FerretDebugRuntime(runtime.descriptor, file) {
                if (calls.incrementAndGet() == 2) {
                    checking.complete(Unit)
                    try { awaitCancellation() } finally { cancelled.complete(Unit) }
                }
            }
            val launch = DapTestLaunch(timeouts = FerretDapTimeouts(if (stop) 5000 else 1000, 2000, 100),
                prepareRuntime = { configured })
            try {
                launch.adapter.autoInitialize = false
                launch.start()
                withTimeout(5000) {
                    launch.adapter.initialized.await()
                    launch.adapter.initializeResponse.completeExceptionally(
                        ResponseErrorException(ResponseError(ResponseErrorCode.RequestFailed, "initialize rejected", null)),
                    )
                    checking.await()
                    if (stop) launch.session.stop()
                    assertEquals(if (stop) 130 else 1, launch.session.completion.await())
                    cancelled.await()
                }
                if (!stop) assertTrue(launch.listener.errors.receive().contains("launch timed out"))
                assertEquals(listOf("initialize", "disconnect"), launch.adapter.history.toList())
                assertFalse(launch.process.isAlive)
            } finally { launch.close() }
        }
    }

    @Test fun wireAcquisitionErrorsRecognizeEscapedNamesAndExcludeOtherCauses() {
        val name = "service \"runtime unavailable\"\\test"
        val quoted = """"service \"runtime unavailable\"\\test""""
        val descriptor = FerretRuntimeDescriptor(name, "App", "wire")
        val unavailable = "Ferret runtime '$name' is unavailable."
        val generic = "Debug launch failed on Ferret runtime '$name'."
        for ((cause, expected) in listOf(
            "connect runtime $quoted: runtime unavailable\nprivate endpoint" to unavailable,
            "runtime unavailable: connect runtime $quoted: constructor returned no runtime" to unavailable,
            "session compilation failed: runtime unavailable" to generic,
            "connect runtime $quoted: runtime unavailable in expression" to generic,
        )) {
            val error = ResponseErrorException(ResponseError(ResponseErrorCode.RequestFailed, "runtime $quoted: $cause", null))
            assertEquals(expected, FerretDapErrors.launchFailure(error, descriptor).message)
        }
    }

    private fun DapTestLaunch.responses(capability: Any?, acknowledgment: Any?) {
        adapter.responseBody = { method, original ->
            when (method) {
                "initialize" -> buildMap<String, Any> {
                    put("supportsConfigurationDoneRequest", true)
                    put("supportsTerminateRequest", true)
                    capability?.let { put("supportsFerretRuntimeSelection", it) }
                }
                "launch" -> acknowledgment
                else -> original
            }
        }
    }
}
