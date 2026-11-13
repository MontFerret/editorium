package org.ferretlang.jetbrains.integration

import org.ferretlang.jetbrains.daemon.FerretdInstallation
import java.nio.file.Path
import java.util.concurrent.TimeUnit

internal fun pinnedTestInstallation(): FerretdInstallation {
    val path = Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH")))
    val process = ProcessBuilder(path.toString(), "--version").redirectErrorStream(true).start()
    try {
        check(process.waitFor(5, TimeUnit.SECONDS)) { "Timed out reading version from $path" }
        val output = process.inputStream.bufferedReader().use { it.readText().trim() }
        check(process.exitValue() == 0 && output.startsWith("ferretd ")) { "Cannot read version from $path: $output" }
        return FerretdInstallation(path, output.removePrefix("ferretd ").trim())
    } finally {
        if (process.isAlive) {
            process.destroyForcibly()
            check(process.waitFor(5, TimeUnit.SECONDS)) { "Version command did not exit" }
        }
    }
}
