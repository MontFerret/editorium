package org.ferretlang.jetbrains.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FerretdPlatformTest {
    @Test
    fun mapsSupportedJvmPlatformsExplicitly() {
        val expected = listOf(
            Triple("Mac OS X", "aarch64", FerretdPlatform("darwin", "arm64", "ferretd", true)),
            Triple("Darwin", "x86_64", FerretdPlatform("darwin", "x64", "ferretd", true)),
            Triple("Linux", "arm64", FerretdPlatform("linux", "arm64", "ferretd", true)),
            Triple("Linux", "amd64", FerretdPlatform("linux", "x64", "ferretd", true)),
            Triple("Windows 11", "aarch64", FerretdPlatform("win32", "arm64", "ferretd.exe", false)),
            Triple("Windows 10", "x86_64", FerretdPlatform("win32", "x64", "ferretd.exe", false)),
        )
        for ((osName, architecture, platform) in expected) {
            assertEquals(platform, FerretdPlatform.resolve(osName, architecture))
        }
    }

    @Test
    fun rejectsUnsupportedOperatingSystemsAndArchitecturesWithContext() {
        val operatingSystem = assertThrows(FerretdPlatformException::class.java) {
            FerretdPlatform.resolve("FreeBSD", "amd64")
        }
        assertTrue(operatingSystem.message.orEmpty().contains("os.name=\"FreeBSD\""))

        val architecture = assertThrows(FerretdPlatformException::class.java) {
            FerretdPlatform.resolve("Linux", "riscv64")
        }
        assertTrue(architecture.message.orEmpty().contains("os.arch=\"riscv64\""))
    }
}
