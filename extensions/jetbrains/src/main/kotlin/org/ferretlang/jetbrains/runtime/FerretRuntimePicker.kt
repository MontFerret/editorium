package org.ferretlang.jetbrains.runtime

import com.intellij.openapi.Disposable
import com.intellij.openapi.ui.ComboBox
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import javax.swing.DefaultListCellRenderer
import javax.swing.DefaultComboBoxModel
import javax.swing.event.PopupMenuEvent
import javax.swing.event.PopupMenuListener

internal class FerretRuntimePicker(private val connection: FerretdDaemonConnection) : Disposable {
    private data class Choice(val name: String, val text: String) {
        override fun toString() = text
    }

    private val combo = ComboBox<Choice>().apply {
        renderer = DefaultListCellRenderer().apply { putClientProperty("html.disable", true) }
    }
    val component get(): javax.swing.JComponent = combo
    var runtimeName: String
        get() = (combo.selectedItem as? Choice)?.name.orEmpty()
        set(value) { populate(connection.catalogState.value.catalog, value) }

    private var displayed: FerretRuntimeCatalog? = null
    private val controls = FerretCatalogControls(connection, showReload = false) { state ->
        if (combo.itemCount == 0 || displayed !== state.catalog) populate(state.catalog, runtimeName)
    }
    val actions get() = controls.panel

    init {
        combo.addPopupMenuListener(object : PopupMenuListener {
            override fun popupMenuWillBecomeVisible(event: PopupMenuEvent) = controls.request()
            override fun popupMenuWillBecomeInvisible(event: PopupMenuEvent) = Unit
            override fun popupMenuCanceled(event: PopupMenuEvent) = Unit
        })
    }

    private fun populate(catalog: FerretRuntimeCatalog?, name: String) {
        displayed = catalog
        val choices = mutableListOf<Choice>()
        val default = catalog?.runtimes?.first { it.name == catalog.defaultRuntime }
        choices += Choice("", default?.let { "Daemon default — ${it.label} (${it.name})" } ?: "Daemon default")
        catalog?.runtimes?.forEach {
            choices += Choice(it.name, "${it.label} — ${it.name} [${it.provider}]")
        }
        if (choices.none { it.name == name }) {
            choices += Choice(name, if (catalog == null) "$name (unresolved)" else "$name (unavailable)")
        }
        combo.model = DefaultComboBoxModel(choices.toTypedArray()).apply {
            selectedItem = choices.first { it.name == name }
        }
    }

    override fun dispose() = controls.dispose()
}
