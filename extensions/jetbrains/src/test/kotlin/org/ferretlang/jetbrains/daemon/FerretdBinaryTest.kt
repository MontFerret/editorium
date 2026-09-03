package org.ferretlang.jetbrains.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission

class FerretdBinaryTest {
    @Test
    fun resolvesThePackagedPlatformPath() {
        val root = Files.createTempDirectory("ferretd-binary-")
        try {
            val platform = FerretdPlatform("win32", "x64", "ferretd.exe", false)
            val expected = root.resolve("ferretd/win32/x64/ferretd.exe")
            Files.createDirectories(expected.parent)
            Files.writeString(expected, "test executable")

            assertEquals(expected, FerretdBinary(root, platform).resolve())
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun resolvesTheInstalledBinaryAndPackagedVersionTogether() {
        val root = Files.createTempDirectory("ferretd-installation-")
        try {
            val platform = FerretdPlatform("win32", "x64", "ferretd.exe", false)
            val executable = root.resolve("ferretd/win32/x64/ferretd.exe")
            Files.createDirectories(executable.parent)
            Files.writeString(executable, "test executable")
            Files.writeString(root.resolve("ferretd/version"), "1.0.0-alpha.5\n")

            assertEquals(
                FerretdInstallation(executable, "1.0.0-alpha.5"),
                FerretdBinary(root, platform).resolveInstallation(),
            )
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun reportsTheExpectedPathWhenTheBinaryIsMissing() {
        val root = Files.createTempDirectory("ferretd-missing-")
        try {
            val error = assertThrows(FerretdBinaryException::class.java) {
                FerretdBinary(
                    root,
                    FerretdPlatform("linux", "arm64", "ferretd", true),
                ).resolve()
            }
            assertTrue(error.message.orEmpty().contains("linux-arm64"))
            assertTrue(error.message.orEmpty().contains("ferretd/linux/arm64/ferretd"))
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun rejectsANonExecutableUnixBinary() {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("posix"))
        val root = Files.createTempDirectory("ferretd-permission-")
        try {
            val path = root.resolve("ferretd/linux/x64/ferretd")
            Files.createDirectories(path.parent)
            Files.writeString(path, "not executable")
            Files.setPosixFilePermissions(path, readOnlyPermissions())

            val error = assertThrows(FerretdBinaryException::class.java) {
                FerretdBinary(
                    root,
                    FerretdPlatform("linux", "x64", "ferretd", true),
                ).resolve()
            }
            assertTrue(error.message.orEmpty().contains("not executable"))
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    private fun readOnlyPermissions(): Set<PosixFilePermission> = setOf(
        PosixFilePermission.OWNER_READ,
        PosixFilePermission.OWNER_WRITE,
        PosixFilePermission.GROUP_READ,
        PosixFilePermission.OTHERS_READ,
    )
}
