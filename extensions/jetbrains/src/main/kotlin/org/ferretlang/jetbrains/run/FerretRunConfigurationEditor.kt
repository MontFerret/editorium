package org.ferretlang.jetbrains.run

import com.intellij.openapi.components.service
import com.intellij.openapi.util.Disposer
import org.ferretlang.jetbrains.runtime.FerretRuntimePicker
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.options.SettingsEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComponentWithBrowseButton
import com.intellij.openapi.ui.TextComponentAccessor
import com.intellij.ui.components.JBTextField
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.FormBuilder
import org.ferretlang.jetbrains.lang.FerretLanguageFileType
import javax.swing.JComponent

class FerretRunConfigurationEditor(
    project: Project,
) : SettingsEditor<FerretRunConfiguration>() {
    private val sourcePathField = TextFieldWithBrowseButton()
    // TextFieldWithBrowseButton installs local path completion even when its button is disabled.
    private val workingDirectoryField = JBTextField()
    private val workingDirectoryControl = ComponentWithBrowseButton(workingDirectoryField, null)
    private val parametersField = JBTextArea(5, 40)

    private val runtime = FerretRuntimePicker(project.service()) { provider ->
        workingDirectoryControl.setButtonEnabled(provider == "native")
        workingDirectoryControl.setButtonVisible(provider == "native")
    }

    init {
        Disposer.register(this, runtime)
        Disposer.register(this, workingDirectoryControl)
        sourcePathField.addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory
                .createSingleFileDescriptor(FerretLanguageFileType)
                .withTitle("Select Ferret Source File"),
        )
        val directories = FileChooserDescriptorFactory.createSingleFolderDescriptor().withTitle("Select Working Directory")
        workingDirectoryControl.addBrowseFolderListener(project, directories, TextComponentAccessor.TEXT_FIELD_WHOLE_TEXT)
        parametersField.emptyText.text = "{}"
    }

    override fun resetEditorFrom(configuration: FerretRunConfiguration) {
        runtime.runtimeName = configuration.runtimeName
        sourcePathField.text = configuration.sourcePath
        workingDirectoryField.text = configuration.workingDirectory
        parametersField.text = configuration.parametersJson
    }

    override fun applyEditorTo(configuration: FerretRunConfiguration) {
        try {
            FerretParameterBindingsJson.parse(parametersField.text)
        } catch (error: IllegalArgumentException) {
            throw ConfigurationException(error.message ?: "The Ferret parameters are invalid.")
        }

        configuration.runtimeName = runtime.runtimeName
        configuration.sourcePath = sourcePathField.text
        configuration.workingDirectory = workingDirectoryField.text
        configuration.parametersJson = parametersField.text
    }

    override fun createEditor(): JComponent =
        FormBuilder
            .createFormBuilder()
            .addLabeledComponent("Runtime:", runtime.component)
            .addComponent(runtime.actions)
            .addComponent(JBLabel(FerretdDaemonConnection.DEBUG_LIMITATION))
            .addLabeledComponent("Source file:", sourcePathField)
            .addLabeledComponent("Working directory:", workingDirectoryControl)
            .addComponent(JBLabel("Leave blank to use the selected runtime’s default. Wire paths are interpreted on the runtime host."))
            .addComponent(JBLabel("Parameters: {\"limit\": 10} binds @limit. Keys omit @; blank means {}."))
            .addLabeledComponentFillVertically("Parameters (JSON object):", JBScrollPane(parametersField))
            .panel
}
