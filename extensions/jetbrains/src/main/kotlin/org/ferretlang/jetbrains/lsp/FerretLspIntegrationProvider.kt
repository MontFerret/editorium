package org.ferretlang.jetbrains.lsp

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspIntegrationProvider

class FerretLspIntegrationProvider : LspIntegrationProvider {
    override fun fileOpened(
        project: Project,
        file: VirtualFile,
        clientStarter: LspIntegrationProvider.LspClientStarter,
    ) {
        if (!FerretLspClientDescriptor.isSupportedFerretFile(file)) {
            return
        }

        clientStarter.ensureClientStarted(FerretLspClientDescriptor(project))
    }
}
