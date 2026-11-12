package org.ferretlang.jetbrains.runtime

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
import javax.swing.event.PopupMenuEvent

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
            openPicker(first)
            openPicker(second)
            assertEquals(CatalogStatus.LOADING, connection.catalogState.value.status)
            Disposer.dispose(defaultEditor)
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
            second.selectedIndex = 0
            namedEditor.applyTo(config)
            assertEquals("", config.runtimeName)
            second.selectedIndex = 2
            namedEditor.applyTo(config)
            assertEquals("Wire", config.runtimeName)
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

    private fun openPicker(combo: JComboBox<*>) {
        combo.popupMenuListeners.forEach { it.popupMenuWillBecomeVisible(PopupMenuEvent(combo)) }
    }
}
