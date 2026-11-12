package org.ferretlang.jetbrains.runtime

import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

class FerretRuntimeConfigFileTest {
    @get:Rule val folder = TemporaryFolder()

    @Test
    fun resolvesAbsoluteProjectRelativeAndEmptyPaths() {
        val file = folder.newFile("runtime configuration.json").toPath()
        assertNull(FerretRuntimeConfigFile.resolve("", null))
        assertEquals(file, FerretRuntimeConfigFile.resolve(file.toString(), null))
        assertEquals(file, FerretRuntimeConfigFile.resolve(file.fileName.toString(), file.parent.toString()))
        assertTrue(assertThrows(IllegalArgumentException::class.java) {
            FerretRuntimeConfigFile.resolve(file.fileName.toString(), null)
        }.message.orEmpty().contains("absolute"))
        assertTrue(assertThrows(IllegalArgumentException::class.java) {
            FerretRuntimeConfigFile.resolve("missing.json", file.parent.toString())
        }.message.orEmpty().contains("does not exist"))
        assertTrue(assertThrows(IllegalArgumentException::class.java) {
            FerretRuntimeConfigFile.resolve(file.parent.toString(), null)
        }.message.orEmpty().contains("regular file"))
    }

    @Test
    fun reportsUnreadableExplicitFile() {
        val file = folder.newFile().toPath()
        assumeTrue(Files.getFileStore(file).supportsFileAttributeView("posix"))
        val original = Files.getPosixFilePermissions(file)
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("---------"))
            assumeTrue(!Files.isReadable(file))
            assertTrue(assertThrows(IllegalArgumentException::class.java) {
                FerretRuntimeConfigFile.resolve(file.toString(), null)
            }.message.orEmpty().contains("unreadable"))
        } finally {
            Files.setPosixFilePermissions(file, original)
        }
    }
}
