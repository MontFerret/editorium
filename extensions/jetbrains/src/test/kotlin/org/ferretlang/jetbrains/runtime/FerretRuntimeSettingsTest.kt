package org.ferretlang.jetbrains.runtime

import com.intellij.openapi.components.service
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.xmlb.XmlSerializer
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.util.ui.UIUtil
import com.intellij.testFramework.PlatformTestUtil
import javax.swing.JButton
import com.intellij.testFramework.replaceService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.daemon.FerretdDaemonLauncher

class FerretRuntimeSettingsTest : BasePlatformTestCase() {
    fun testSettingsFormAppliesOnlySavedTextAndRefusesReloadWhileBusy() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val connection = FerretdDaemonConnection.testing(scope, FerretdDaemonLauncher.testing(
            scope, { error("Unexpected startup") }, { _, _, _ -> error("Unexpected process") }, { _, _ -> error("Unexpected RPC") },
        ))
        project.replaceService(FerretdDaemonConnection::class.java, connection, testRootDisposable)
        val configurable = FerretRuntimeConfigurable(project)
        val component = configurable.createComponent()
        val field = requireNotNull(UIUtil.findComponentOfType(component, TextFieldWithBrowseButton::class.java))
        val button = UIUtil.findComponentsOfType(component, JButton::class.java).single { it.text == "Reload runtimes" }
        try {
            configurable.reset()
            field.text = "unapplied.json"
            assertTrue(configurable.isModified)
            assertEquals("", connection.configPath)
            configurable.reset()
            assertEquals("", field.text)
            connection.admitDebug("").use {
                field.text = "runtime file.json"
                configurable.apply()
                assertFalse(configurable.isModified)
                PlatformTestUtil.waitWithEventsDispatching("Reload stayed enabled during a launch", { !button.isEnabled }, 5)
                assertEquals(CatalogStatus.RELOAD_REQUIRED, connection.catalogState.value.status)
                assertNull(connection.ensureCatalog())
            }
            PlatformTestUtil.waitWithEventsDispatching("Reload stayed disabled after cleanup", { button.isEnabled }, 5)
            assertEquals(CatalogStatus.RELOAD_REQUIRED, connection.catalogState.value.status)
        } finally {
            configurable.disposeUIResources()
            runBlocking { connection.closeForTest() }
            scope.cancel()
        }
    }

    fun testOnlyTheEnteredPathSurvivesProjectStateSerialization() {
        val settings = project.service<FerretRuntimeSettings>()
        val other = com.intellij.openapi.project.ProjectManager.getInstance().defaultProject.service<FerretRuntimeSettings>()
        assertNotSame(settings, other)
        val otherPath = other.state.runtimeConfigPath
        val original = settings.state.runtimeConfigPath
        try {
            assertEquals("", original.orEmpty())
            settings.state.runtimeConfigPath = ".ferret/dev runtimes.json"
            assertEquals(otherPath, other.state.runtimeConfigPath)
            val xml = XmlSerializer.serialize(settings.state)
            assertEquals(listOf("runtimeConfigPath"), xml.getChildren("option").map { it.getAttributeValue("name") })
            val restored = FerretRuntimeSettings()
            restored.loadState(XmlSerializer.deserialize(xml, FerretRuntimeSettings.Options::class.java))
            assertEquals(settings.state.runtimeConfigPath, restored.state.runtimeConfigPath)
            restored.state.runtimeConfigPath = ""
            assertEquals(".ferret/dev runtimes.json", settings.state.runtimeConfigPath)
        } finally {
            settings.state.runtimeConfigPath = original
        }
    }
}
