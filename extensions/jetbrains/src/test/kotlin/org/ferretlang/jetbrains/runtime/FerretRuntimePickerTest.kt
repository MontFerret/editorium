package org.ferretlang.jetbrains.runtime

import com.intellij.ide.ui.laf.darcula.ui.DarculaJBPopupComboPopup
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.replaceService
import com.intellij.util.ui.UIUtil
import kotlinx.coroutines.*
import org.ferretlang.jetbrains.daemon.*
import org.ferretlang.jetbrains.execution.FakeFerretdRpc
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunConfigurationEditor
import org.ferretlang.jetbrains.run.FerretRunConfigurationType
import java.nio.file.Path
import javax.swing.JComboBox

class FerretRuntimePickerTest : BasePlatformTestCase() {
    fun testEditorsShareDiscoveryAndRetainTheSelectionAcrossLoadingAndMissingEntries() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val gate = CompletableDeferred<Unit>()
        val version = "1.0.0-alpha.11"
        val process = FakeDaemonProcess.ready(version)
        val rpc = FakeFerretdRpc(version, Path.of("."), emptyList(), process::destroy)
        rpc.discover = {
            gate.await()
            FerretRuntimeCatalog("Wire", listOf(
                FerretRuntimeDescriptor("local", "Same", "native"),
                FerretRuntimeDescriptor("Wire", "Same", "wire"),
            ))
        }
        val connection = FerretdDaemonConnection.testing(scope, FerretdDaemonLauncher.testing(
            scope, { FerretdInstallation(Path.of("ferretd"), version) }, { _, _, _ -> process }, { _, _ -> rpc },
        ))
        project.replaceService(FerretdDaemonConnection::class.java, connection, testRootDisposable)
        val defaultEditor = FerretRunConfigurationEditor(project)
        val namedEditor = FerretRunConfigurationEditor(project)
        val factory = FerretRunConfigurationType.getInstance().configurationFactories.single()
        val config = factory.createTemplateConfiguration(project) as FerretRunConfiguration
        try {
            defaultEditor.resetFrom(config)
            namedEditor.resetFrom(config)
            assertEquals(CatalogStatus.UNLOADED, connection.catalogState.value.status)
            val first = combo(defaultEditor)
            val second = combo(namedEditor)
            first.firePopupMenuWillBecomeVisible()
            assertFalse((second as ComboBox<*>).isSwingPopup)
            @Suppress("UNCHECKED_CAST")
            val popup = object : DarculaJBPopupComboPopup<Any>(second as JComboBox<Any>) {
                // The headless IDE does not map a native window. Exercise the platform's visible-popup
                // model-change and selection handlers with the actual list that it creates.
                override fun isVisible(): Boolean = getPopup()?.isDisposed == false
            }
            popup.show()
            val listPopup = requireNotNull(popup.popup)
            Disposer.register(testRootDisposable) {
                popup.uninstallingUI()
                if (!listPopup.isDisposed) Disposer.dispose(listPopup)
            }
            second.firePopupMenuWillBecomeVisible()
            assertEquals(CatalogStatus.LOADING, connection.catalogState.value.status)
            Disposer.dispose(defaultEditor)
            config.workingDirectory = """  C:\Remote Host\data  """
            config.runtimeName = "Removed"
            namedEditor.resetFrom(config)
            assertTrue(second.selectedItem.toString().contains("unresolved"))
            gate.complete(Unit)
            PlatformTestUtil.waitWithEventsDispatching("Picker did not receive the catalog", {
                second.selectedItem.toString().contains("unavailable")
            }, 10)
            namedEditor.applyTo(config)
            assertEquals("Removed", config.runtimeName)
            assertEquals(1, rpc.calls.count { it == "listRuntimes" })
            assertEquals("Daemon default — Same (Wire)", second.getItemAt(0).toString())
            assertEquals("Same — local [native]", second.getItemAt(1).toString())
            assertEquals("Same — Wire [wire]", second.getItemAt(2).toString())
            val directory = UIUtil.findComponentsOfType(namedEditor.component, com.intellij.openapi.ui.ComponentWithBrowseButton::class.java)
                .single { it !is com.intellij.openapi.ui.TextFieldWithBrowseButton }
            val browse = requireNotNull(UIUtil.findComponentOfType(directory, javax.swing.JButton::class.java))
            assertFalse(browse.isEnabled)
            second.selectedIndex = 1
            assertTrue(browse.isEnabled)
            second.selectedIndex = 0
            assertFalse(browse.isEnabled)
            assertTrue((directory.childComponent as javax.swing.JTextField).isEditable)
            namedEditor.applyTo(config)
            assertEquals("", config.runtimeName)
            assertTrue(popup.isVisible)
            assertSame(listPopup, popup.popup)
            assertEquals(4, listPopup.list.model.size)
            listPopup.list.selectedIndex = 2
            listPopup.handleSelect(true)
            PlatformTestUtil.waitWithEventsDispatching("Selection from the open popup did not reach the editor", {
                second.selectedIndex == 2
            }, 5)
            namedEditor.applyTo(config)
            assertEquals("Wire", config.runtimeName)
            assertEquals("""  C:\Remote Host\data  """, config.workingDirectory)
        } finally {
            gate.complete(Unit)
            Disposer.dispose(defaultEditor)
            Disposer.dispose(namedEditor)
            runBlocking { connection.closeForTest() }
            scope.cancel()
        }
    }

    private fun combo(editor: FerretRunConfigurationEditor): JComboBox<*> =
        requireNotNull(UIUtil.findComponentOfType(editor.component, JComboBox::class.java))
}
