package org.ferretlang.jetbrains.runtime

import com.intellij.openapi.components.service
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.FormBuilder
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import javax.swing.JComponent
import javax.swing.JToggleButton

internal class FerretRuntimeConfigurable(private val project: Project) : Configurable {
    private val connection get() = project.service<FerretdDaemonConnection>()
    private var path: TextFieldWithBrowseButton? = null
    private var controls: FerretCatalogControls? = null

    override fun getDisplayName() = "Ferret"

    override fun createComponent(): JComponent {
        val field = TextFieldWithBrowseButton()
        path = field
        field.addBrowseFolderListener(project, FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor()
            .withTitle("Select Runtime Configuration File"))
        val toggle = JToggleButton("Runtime catalog")
        val catalog = JBTextArea(6, 40).apply { isEditable = false }
        val catalogPane = JBScrollPane(catalog).apply { isVisible = false }
        val actions = FerretCatalogControls(connection, showReload = true) { value ->
            catalog.text = value.catalog?.let { snapshot ->
                snapshot.runtimes.joinToString("\n") {
                    val marker = if (it.name == snapshot.defaultRuntime) " (daemon default)" else ""
                    "${it.label} — ${it.name} [${it.provider}]$marker"
                }
            }.orEmpty()
        }
        controls = actions
        toggle.addActionListener {
            catalogPane.isVisible = toggle.isSelected
            if (toggle.isSelected) actions.request()
        }
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Runtime configuration file:", field)
            .addComponent(toggle)
            .addComponent(catalogPane)
            .addComponent(actions.panel)
            .addComponentFillVertically(javax.swing.JPanel(), 0).panel
    }

    override fun isModified(): Boolean = path?.let { it.text != connection.configPath } ?: false
    override fun apply() { path?.let { connection.applyConfigPath(it.text) } }
    override fun reset() { path?.text = connection.configPath }

    override fun disposeUIResources() {
        controls?.dispose()
        controls = null
        path?.dispose()
        path = null
    }
}
