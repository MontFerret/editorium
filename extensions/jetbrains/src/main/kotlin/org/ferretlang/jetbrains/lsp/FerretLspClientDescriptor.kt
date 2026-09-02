package org.ferretlang.jetbrains.lsp

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.ProjectWideLspClientDescriptor
import com.intellij.platform.lsp.api.customization.LspCustomization
import com.intellij.platform.lsp.api.customization.LspFormattingSupport
import org.ferretlang.jetbrains.daemon.FerretdBinary
import org.ferretlang.jetbrains.daemon.FerretdBinaryException
import org.ferretlang.jetbrains.daemon.FerretdPlatformException
import org.ferretlang.jetbrains.lang.FerretLanguageFileType

internal class FerretLspClientDescriptor(
    project: Project,
    private val ferretdBinary: FerretdBinary? = null,
) : ProjectWideLspClientDescriptor(project, "Ferret") {
    override fun isSupportedFile(file: VirtualFile): Boolean = isSupportedFerretFile(file)

    override val lspCustomization: LspCustomization = object : LspCustomization() {
        override val formattingCustomizer = object : LspFormattingSupport() {
            override fun shouldFormatThisFileExclusivelyByServer(
                file: VirtualFile,
                ideCanFormatThisFileItself: Boolean,
                serverExplicitlyWantsToFormatThisFile: Boolean,
            ): Boolean = isSupportedFerretFile(file)
        }
    }

    override fun createCommandLine(): GeneralCommandLine {
        val executable = try {
            (ferretdBinary ?: FerretdBinary.installed()).resolve()
        } catch (error: FerretdBinaryException) {
            throw startupException(error)
        } catch (error: FerretdPlatformException) {
            throw startupException(error)
        }

        val commandLine = GeneralCommandLine(executable.toString(), "lsp")
        project.basePath?.let { commandLine.withWorkDirectory(it) }

        return commandLine
    }

    private fun startupException(error: IllegalStateException): ExecutionException =
        ExecutionException("Cannot start Ferret language server: ${error.message}", error)

    companion object {
        fun isSupportedFerretFile(file: VirtualFile): Boolean =
            file.isInLocalFileSystem && file.fileType === FerretLanguageFileType
    }
}
