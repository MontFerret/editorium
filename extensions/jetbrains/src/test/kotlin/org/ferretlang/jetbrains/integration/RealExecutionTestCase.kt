package org.ferretlang.jetbrains.integration

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.daemon.FerretdInstallation
import org.ferretlang.jetbrains.daemon.FerretdDaemonLauncher
import org.ferretlang.jetbrains.daemon.GrpcFerretdRpc
import org.ferretlang.jetbrains.execution.FerretExecutionClient
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.junit.After
import org.junit.Before
import java.nio.file.Files
import java.nio.file.Path

internal abstract class RealExecutionTestCase {
    protected lateinit var scope: CoroutineScope
    protected lateinit var connection: FerretdDaemonConnection
    protected lateinit var root: Path
    protected lateinit var installation: FerretdInstallation
    protected var port = 0

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        installation = pinnedTestInstallation()
        connection = FerretdDaemonConnection.testing(scope, FerretdDaemonLauncher.testing(
            scope,
            { installation },
            { installed, credential, configFile ->
                ProcessBuilder(FerretdDaemonLauncher.command(installed, configFile)).apply {
                    environment()["FERRETD_AUTH_TOKEN"] = credential
                }.start()
            },
            { readyPort, credential ->
                port = readyPort
                GrpcFerretdRpc.connect(readyPort, credential)
            },
        ))
        root = Files.createTempDirectory("ferret-jetbrains-integration-")
    }

    @After
    fun tearDown() {
        runBlocking { connection.closeForTest() }
        scope.cancel()
        root.toFile().deleteRecursively()
    }

    protected fun execute(
        source: Path,
        parameters: FerretParameterBindings = FerretParameterBindings.EMPTY,
        workingDirectory: Path? = root,
        projectRoot: Path = root,
        daemon: FerretdDaemonConnection = connection,
        runtimeName: String = "",
    ): RecordingExecution {
        val sink = RecordingExecution()
        sink.handle = FerretExecutionClient(daemon).start(
            FerretLaunchInput(
                source.toString(),
                workingDirectory?.toString().orEmpty(),
                projectRoot.toString(),
                parameters,
                runtimeName,
            ),
            sink,
        )
        return sink
    }

    protected fun write(relativePath: String, source: String): Path {
        val path = root.resolve(relativePath)
        Files.createDirectories(path.parent)
        return Files.writeString(path, source)
    }

    protected suspend fun <T> CompletableDeferred<T>.awaitResult(): T = withTimeout(20_000L) { this@awaitResult.await() }
}
