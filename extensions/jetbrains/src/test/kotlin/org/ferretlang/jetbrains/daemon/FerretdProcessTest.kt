package org.ferretlang.jetbrains.daemon

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission

class FerretdProcessTest {
    private val services = mutableListOf<FerretdProcess>()
    private lateinit var root: Path

    @Before
    fun requirePosixHost() {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("posix"))
        root = Files.createTempDirectory("ferretd-process-")
    }

    @After
    fun cleanUp() {
        for (service in services) {
            service.dispose()
        }
        if (::root.isInitialized) {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun startsOncePreservesStdoutAndStopsCleanly() {
        val service = serviceWithScript(
            """
            #!/bin/sh
            if [ "${'$'}1" != "lsp" ]; then exit 90; fi
            printf 'ready\n'
            trap 'exit 0' TERM
            while :; do sleep 1; done
            """.trimIndent(),
        )

        val first = service.start()
        assertEquals("ready", first.inputStream.bufferedReader().readLine())
        assertTrue(service.isRunning())
        assertSame(first, service.start())

        service.stop()
        assertFalse(first.isAlive)
        assertFalse(service.isRunning())
    }

    @Test
    fun reportsImmediateExitCodeAndStderrAndCanRestart() {
        val script = createScript(
            """
            #!/bin/sh
            printf 'startup exploded\n' >&2
            exit 23
            """.trimIndent(),
        )
        val service = register(FerretdProcess.createForTest(binaryFor(script)))
        val error = assertThrows(FerretdProcessException::class.java) { service.start() }
        assertTrue(error.message.orEmpty().contains("code 23"))
        assertTrue(error.message.orEmpty().contains("startup exploded"))
        assertFalse(service.isRunning())

        writeExecutable(
            script,
            """
            #!/bin/sh
            trap 'exit 0' TERM
            while :; do sleep 1; done
            """.trimIndent(),
        )
        val restarted = service.start()
        assertTrue(restarted.isAlive)
    }

    @Test
    fun restartsAProcessThatExitsAfterStartup() {
        val script = createScript(
            """
            #!/bin/sh
            sleep 1
            """.trimIndent(),
        )
        val service = register(FerretdProcess.createForTest(binaryFor(script)))
        val first = service.start()
        assertTrue(first.waitFor(3, java.util.concurrent.TimeUnit.SECONDS))
        assertFalse(service.isRunning())

        writeExecutable(
            script,
            """
            #!/bin/sh
            trap 'exit 0' TERM
            while :; do sleep 1; done
            """.trimIndent(),
        )
        val restarted = service.start()
        assertTrue(restarted.isAlive)
        assertTrue(service.isRunning())
    }

    @Test
    fun wrapsProcessLaunchFailures() {
        val script = createScript("#!/definitely/missing/ferretd-test-interpreter")
        val service = register(FerretdProcess.createForTest(binaryFor(script)))

        val error = assertThrows(FerretdProcessException::class.java) { service.start() }
        assertTrue(error.message.orEmpty().contains("Failed to launch bundled ferretd"))
        assertTrue(error.cause != null)
    }

    @Test
    fun forciblyStopsAProcessThatIgnoresTermination() {
        val service = serviceWithScript(
            """
            #!/bin/sh
            trap '' TERM
            while :; do sleep 1; done
            """.trimIndent(),
        )
        val process = service.start()

        service.stop()

        assertFalse(process.isAlive)
        assertFalse(service.isRunning())
    }

    @Test
    fun disposeStopsTheOwnedProcess() {
        val service = serviceWithScript(
            """
            #!/bin/sh
            trap 'exit 0' TERM
            while :; do sleep 1; done
            """.trimIndent(),
        )
        val process = service.start()

        service.dispose()

        assertFalse(process.isAlive)
        assertFalse(service.isRunning())
    }

    private fun serviceWithScript(contents: String): FerretdProcess {
        val script = createScript(contents)
        return register(FerretdProcess.createForTest(binaryFor(script), root))
    }

    private fun binaryFor(script: Path): FerretdBinary {
        val platform = FerretdPlatform("linux", "x64", "ferretd", true)
        val pluginRoot = script.parent.parent.parent.parent
        return FerretdBinary(pluginRoot, platform)
    }

    private fun createScript(contents: String): Path {
        val script = root.resolve("ferretd/linux/x64/ferretd")
        Files.createDirectories(script.parent)
        writeExecutable(script, contents)
        return script
    }

    private fun writeExecutable(path: Path, contents: String) {
        Files.writeString(path, contents + "\n")
        Files.setPosixFilePermissions(
            path,
            setOf(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE,
                PosixFilePermission.GROUP_READ,
                PosixFilePermission.GROUP_EXECUTE,
                PosixFilePermission.OTHERS_READ,
                PosixFilePermission.OTHERS_EXECUTE,
            ),
        )
    }

    private fun register(service: FerretdProcess): FerretdProcess {
        services.add(service)
        return service
    }
}
