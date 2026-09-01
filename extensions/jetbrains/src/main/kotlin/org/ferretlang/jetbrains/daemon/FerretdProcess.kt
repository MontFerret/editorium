package org.ferretlang.jetbrains.daemon

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.jetbrains.annotations.TestOnly
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.TimeUnit

@Service(Service.Level.PROJECT)
internal class FerretdProcess private constructor(
    binaryProvider: () -> FerretdBinary,
    private val workingDirectory: Path?,
) : Disposable {
    private val binary: FerretdBinary by lazy(binaryProvider)
    private var activeProcess: Process? = null
    private var activeStderrThread: Thread? = null

    constructor(project: Project) : this(
        binaryProvider = { FerretdBinary.installed() },
        workingDirectory = project.basePath?.let(Paths::get),
    )

    @Synchronized
    fun start(): Process {
        activeProcess?.takeIf(Process::isAlive)?.let { return it }
        clearFinishedProcess()

        val executable = try {
            binary.resolve()
        } catch (error: FerretdPlatformException) {
            LOG.warn(error.message, error)
            throw error
        } catch (error: FerretdBinaryException) {
            LOG.warn(error.message, error)
            throw error
        }
        val builder = ProcessBuilder(executable.toString(), "lsp")
            .redirectInput(ProcessBuilder.Redirect.PIPE)
            .redirectOutput(ProcessBuilder.Redirect.PIPE)
            .redirectError(ProcessBuilder.Redirect.PIPE)
        workingDirectory?.takeIf(Files::isDirectory)?.let { builder.directory(it.toFile()) }

        val started = try {
            builder.start()
        } catch (error: IOException) {
            val failure = FerretdProcessException("Failed to launch bundled ferretd: $executable.", error)
            LOG.warn(failure.message, failure)
            throw failure
        } catch (error: SecurityException) {
            val failure = FerretdProcessException("Permission denied while launching bundled ferretd: $executable.", error)
            LOG.warn(failure.message, failure)
            throw failure
        }

        val stderr = StringBuilder()
        val stderrThread = startStderrPump(started, stderr)
        activeProcess = started
        activeStderrThread = stderrThread

        try {
            if (started.waitFor(STARTUP_WINDOW_MILLISECONDS, TimeUnit.MILLISECONDS)) {
                stderrThread.join(STDERR_JOIN_MILLISECONDS)
                val exitCode = started.exitValue()
                val detail = stderrSnapshot(stderr).ifEmpty { "no stderr output" }
                clearProcess(started)
                closeProcessStreams(started)
                val failure = FerretdProcessException(
                    "Bundled ferretd exited during startup with code $exitCode: $detail",
                )
                LOG.warn(failure.message, failure)
                throw failure
            }
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            started.destroyForcibly()
            clearProcess(started)
            closeProcessStreams(started)
            throw FerretdProcessException("Interrupted while verifying bundled ferretd startup.", error)
        }
        return started
    }

    @Synchronized
    fun isRunning(): Boolean = activeProcess?.isAlive == true

    @Synchronized
    fun stop() {
        val process = activeProcess ?: return
        val stderrThread = activeStderrThread
        clearProcess(process)
        try {
            closeQuietly(process.outputStream)
            if (process.isAlive && !process.waitFor(STDIN_GRACE_MILLISECONDS, TimeUnit.MILLISECONDS)) {
                process.destroy()
            }
            if (process.isAlive && !process.waitFor(TERMINATION_GRACE_MILLISECONDS, TimeUnit.MILLISECONDS)) {
                process.destroyForcibly()
            }
            if (process.isAlive && !process.waitFor(FORCED_TERMINATION_MILLISECONDS, TimeUnit.MILLISECONDS)) {
                throw FerretdProcessException("Bundled ferretd did not terminate after a forced stop.")
            }
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            process.destroyForcibly()
            throw FerretdProcessException("Interrupted while stopping bundled ferretd.", error)
        } finally {
            closeProcessStreams(process)
            try {
                stderrThread?.join(STDERR_JOIN_MILLISECONDS)
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    override fun dispose() {
        try {
            stop()
        } catch (error: FerretdProcessException) {
            LOG.warn("Failed to stop bundled ferretd during project disposal.", error)
        }
    }

    private fun startStderrPump(process: Process, stderr: StringBuilder): Thread =
        Thread.ofVirtual()
            .name("ferretd-stderr")
            .start {
                try {
                    process.errorStream.reader().use { reader ->
                        val characters = CharArray(STDERR_READ_SIZE)
                        while (true) {
                            val count = reader.read(characters)
                            if (count < 0) {
                                break
                            }
                            val chunk = String(characters, 0, count)
                            appendStderr(stderr, chunk)
                            if (chunk.isNotBlank()) {
                                LOG.warn("ferretd stderr: ${chunk.trimEnd()}")
                            }
                        }
                    }
                } catch (error: IOException) {
                    if (process.isAlive) {
                        LOG.warn("Failed to read ferretd stderr.", error)
                    }
                }
            }

    private fun appendStderr(stderr: StringBuilder, chunk: String) {
        synchronized(stderr) {
            stderr.append(chunk)
            val overflow = stderr.length - MAXIMUM_STDERR_CHARACTERS
            if (overflow > 0) {
                stderr.delete(0, overflow)
            }
        }
    }

    private fun stderrSnapshot(stderr: StringBuilder): String = synchronized(stderr) {
        stderr.toString().trim()
    }

    private fun clearFinishedProcess() {
        activeProcess?.let(::closeProcessStreams)
        activeProcess = null
        activeStderrThread = null
    }

    private fun clearProcess(process: Process) {
        if (activeProcess === process) {
            activeProcess = null
            activeStderrThread = null
        }
    }

    private fun closeProcessStreams(process: Process) {
        closeQuietly(process.inputStream)
        closeQuietly(process.errorStream)
        closeQuietly(process.outputStream)
    }

    private fun closeQuietly(closeable: AutoCloseable) {
        try {
            closeable.close()
        } catch (_: Exception) {
            // Process shutdown and cleanup must continue even if a pipe is already closed.
        }
    }

    companion object {
        private val LOG = Logger.getInstance(FerretdProcess::class.java)
        private const val STARTUP_WINDOW_MILLISECONDS = 250L
        private const val STDIN_GRACE_MILLISECONDS = 250L
        private const val TERMINATION_GRACE_MILLISECONDS = 1_500L
        private const val FORCED_TERMINATION_MILLISECONDS = 2_000L
        private const val STDERR_JOIN_MILLISECONDS = 500L
        private const val STDERR_READ_SIZE = 2_048
        private const val MAXIMUM_STDERR_CHARACTERS = 32 * 1_024

        @TestOnly
        fun createForTest(binary: FerretdBinary, workingDirectory: Path? = null): FerretdProcess =
            FerretdProcess({ binary }, workingDirectory)
    }
}
