package org.ferretlang.jetbrains.lsp

import com.intellij.execution.ExecutionException
import com.intellij.openapi.project.ProjectManager
import com.intellij.platform.lsp.api.customization.LspFormattingSupport
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.ferretlang.jetbrains.daemon.FerretdBinary
import org.ferretlang.jetbrains.daemon.FerretdBinaryException
import org.ferretlang.jetbrains.daemon.FerretdPlatform
import org.ferretlang.jetbrains.lang.FerretLanguageFileType
import org.junit.Assert
import java.nio.file.Files
import java.nio.file.Path

class FerretLspClientDescriptorTest : BasePlatformTestCase() {
    fun testSupportedFilesMatchProviderActivation() {
        val descriptor = FerretLspClientDescriptor(project)
        val ferretFile = myFixture.tempDirFixture.createFile("query.fql", "RETURN 1")
        val unrelatedFile = myFixture.tempDirFixture.createFile("query.txt", "RETURN 1")
        val nonLocalFerretFile = LightVirtualFile("scratch.fql", FerretLanguageFileType, "RETURN 1")

        assertTrue(descriptor.isSupportedFile(ferretFile))
        assertFalse(descriptor.isSupportedFile(unrelatedFile))
        assertFalse(descriptor.isSupportedFile(nonLocalFerretFile))
    }

    fun testFormattingUsesFerretdExclusivelyForSupportedFiles() {
        val descriptor = FerretLspClientDescriptor(project)
        val ferretFile = myFixture.tempDirFixture.createFile("query.fql", "RETURN 1")
        val unrelatedFile = myFixture.tempDirFixture.createFile("query.txt", "RETURN 1")
        val nonLocalFerretFile = LightVirtualFile("scratch.fql", FerretLanguageFileType, "RETURN 1")
        val formattingSupport = descriptor.lspCustomization.formattingCustomizer

        assertTrue(formattingSupport is LspFormattingSupport)
        formattingSupport as LspFormattingSupport
        assertTrue(formattingSupport.shouldFormatThisFileExclusivelyByServer(ferretFile, true, false))
        assertTrue(formattingSupport.shouldFormatThisFileExclusivelyByServer(ferretFile, false, true))
        assertFalse(formattingSupport.shouldFormatThisFileExclusivelyByServer(unrelatedFile, false, false))
        assertFalse(formattingSupport.shouldFormatThisFileExclusivelyByServer(nonLocalFerretFile, false, false))
    }

    fun testCommandLineUsesOnlyThePackagedBinaryAndLspArgument() {
        val root = Files.createTempDirectory("ferret-lsp-command-")

        try {
            val platform = FerretdPlatform("win32", "x64", "ferretd.exe", false)
            val executable = root.resolve("ferretd/win32/x64/ferretd.exe")
            Files.createDirectories(executable.parent)
            Files.writeString(executable, "test executable")

            val commandLine = FerretLspClientDescriptor(
                project,
                FerretdBinary(root, platform),
            ).createCommandLine()

            assertEquals(executable.toString(), commandLine.exePath)
            assertEquals(listOf("lsp"), commandLine.parametersList.list)
            assertEquals(Path.of(requireNotNull(project.basePath)), commandLine.workingDirectory)
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    fun testCommandLineLeavesWorkingDirectoryUnsetWithoutAProjectBasePath() {
        val root = Files.createTempDirectory("ferret-lsp-no-base-path-")

        try {
            val platform = FerretdPlatform("win32", "x64", "ferretd.exe", false)
            val executable = root.resolve("ferretd/win32/x64/ferretd.exe")
            Files.createDirectories(executable.parent)
            Files.writeString(executable, "test executable")
            val projectWithoutBasePath = ProjectManager.getInstance().defaultProject

            assertNull(projectWithoutBasePath.basePath)

            val commandLine = FerretLspClientDescriptor(
                projectWithoutBasePath,
                FerretdBinary(root, platform),
            ).createCommandLine()

            assertEquals(executable.toString(), commandLine.exePath)
            assertEquals(listOf("lsp"), commandLine.parametersList.list)
            assertNull(commandLine.workingDirectory)
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    fun testMissingBinaryBecomesAnLspStartupError() {
        val root = Files.createTempDirectory("ferret-lsp-missing-")

        try {
            val descriptor = FerretLspClientDescriptor(
                project,
                FerretdBinary(
                    root,
                    FerretdPlatform("linux", "arm64", "ferretd", true),
                ),
            )

            val error = Assert.assertThrows(ExecutionException::class.java) {
                descriptor.createCommandLine()
            }

            assertTrue(error.message.orEmpty().contains("Cannot start Ferret language server"))
            assertTrue(error.message.orEmpty().contains("ferretd/linux/arm64/ferretd"))
            assertTrue(error.cause is FerretdBinaryException)
        } finally {
            root.toFile().deleteRecursively()
        }
    }
}
