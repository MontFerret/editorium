package org.ferretlang.jetbrains.lang

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class FerretLanguageFileTypeTest : BasePlatformTestCase() {
    fun testFileTypeMetadata() {
        assertEquals("Ferret", FerretLanguageFileType.name)
        assertEquals("Ferret Query Language", FerretLanguageFileType.description)
        assertEquals("fql", FerretLanguageFileType.defaultExtension)
        assertSame(FerretLanguage, FerretLanguageFileType.language)
    }

    fun testFqlFilesUseFerretFileType() {
        val registered = FileTypeManager.getInstance().getFileTypeByExtension("fql")
        assertSame(FerretLanguageFileType, registered)

        val file = myFixture.tempDirFixture.createFile("example.fql", "RETURN 1")
        assertSame(FerretLanguageFileType, file.fileType)
    }

    fun testPluginDescriptorLoads() {
        val pluginId = PluginId.getId("org.ferretlang.jetbrains")
        assertNotNull(PluginManagerCore.getPlugin(pluginId))
        assertTrue(PluginManagerCore.isLoaded(pluginId))
    }
}
