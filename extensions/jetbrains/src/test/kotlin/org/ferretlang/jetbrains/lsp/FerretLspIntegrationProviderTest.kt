package org.ferretlang.jetbrains.lsp

import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspClientDescriptor
import com.intellij.platform.lsp.api.LspIntegrationProvider
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.ferretlang.jetbrains.lang.FerretLanguageFileType

class FerretLspIntegrationProviderTest : BasePlatformTestCase() {
    fun testPluginRegistersTheFerretProvider() {
        assertTrue(
            LspIntegrationProvider.EP_NAME.extensionList.any {
                it is FerretLspIntegrationProvider
            },
        )
    }

    fun testLocalFerretFileStartsAProjectWideClient() {
        val file = myFixture.tempDirFixture.createFile("query.fql", "RETURN 1")

        assertTrue(openedDescriptor(file) is FerretLspClientDescriptor)
    }

    fun testUnrelatedFileDoesNotStartAClient() {
        val file = myFixture.tempDirFixture.createFile("README.md", "# Project")

        assertNull(openedDescriptor(file))
    }

    fun testNonLocalFerretFileDoesNotStartAClient() {
        val file = LightVirtualFile("scratch.fql", FerretLanguageFileType, "RETURN 1")

        assertNull(openedDescriptor(file))
    }

    private fun openedDescriptor(file: VirtualFile): LspClientDescriptor? {
        var startedDescriptor: LspClientDescriptor? = null
        val starter = object : LspIntegrationProvider.LspClientStarter {
            override fun ensureClientStarted(descriptor: LspClientDescriptor) {
                startedDescriptor = descriptor
            }
        }

        FerretLspIntegrationProvider().fileOpened(project, file, starter)

        return startedDescriptor
    }
}
