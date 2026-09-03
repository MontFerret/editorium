package org.ferretlang.jetbrains.run

import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.ferretlang.jetbrains.lang.FerretLanguageFileType
import java.nio.file.Files
import java.nio.file.Path

class FerretRunSourceFileTest : BasePlatformTestCase() {
    private lateinit var temporaryRoot: Path

    override fun setUp() {
        super.setUp()
        temporaryRoot = Files.createTempDirectory("ferret-run-source-")
    }

    override fun tearDown() {
        try {
            temporaryRoot.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    fun testAcceptsOnlyLocalFilesRecognizedAsFerretWithTheExactExtension() {
        val ferret = createLocalFile("query.fql")
        val unrelated = createLocalFile("query.txt")
        val nonLocal = LightVirtualFile("query.fql", FerretLanguageFileType, "RETURN 1")
        val wrongExtension = LocalLightVirtualFile("query.txt", FerretLanguageFileType)
        val wrongFileType = LocalLightVirtualFile("query.fql", PlainTextFileType.INSTANCE)

        assertTrue(FerretRunSourceFile.isEligible(ferret))
        assertFalse(FerretRunSourceFile.isEligible(unrelated))
        assertFalse(FerretRunSourceFile.isEligible(nonLocal))
        assertFalse(FerretRunSourceFile.isEligible(wrongExtension))
        assertFalse(FerretRunSourceFile.isEligible(wrongFileType))
    }

    private fun createLocalFile(name: String) =
        requireNotNull(
            LocalFileSystem.getInstance().refreshAndFindFileByNioFile(
                Files.writeString(temporaryRoot.resolve(name), "RETURN 1"),
            ),
        )

    private class LocalLightVirtualFile(
        name: String,
        fileType: FileType,
    ) : LightVirtualFile(name, fileType, "RETURN 1") {
        override fun isInLocalFileSystem(): Boolean = true
    }
}
