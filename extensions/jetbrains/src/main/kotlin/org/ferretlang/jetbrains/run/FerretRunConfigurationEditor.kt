package org.ferretlang.jetbrains.run

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.options.SettingsEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.FormBuilder
import org.ferretlang.jetbrains.lang.FerretLanguageFileType
import javax.swing.JComponent

class FerretRunConfigurationEditor(
    project: Project,
) : SettingsEditor<FerretRunConfiguration>() {
    private val sourcePathField = TextFieldWithBrowseButton()
    private val workingDirectoryField = TextFieldWithBrowseButton()
    private val parametersField = JBTextArea(5, 40)

    init {
        sourcePathField.addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory
                .createSingleFileDescriptor(FerretLanguageFileType)
                .withTitle("Select Ferret Source File"),
        )
        workingDirectoryField.addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory
                .createSingleFolderDescriptor()
                .withTitle("Select Working Directory"),
        )
        parametersField.emptyText.text = "{}"
    }

    override fun resetEditorFrom(configuration: FerretRunConfiguration) {
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

        configuration.sourcePath = sourcePathField.text
        configuration.workingDirectory = workingDirectoryField.text
        configuration.parametersJson = parametersField.text
    }

    override fun createEditor(): JComponent =
        FormBuilder
            .createFormBuilder()
            .addLabeledComponent("Source file:", sourcePathField)
            .addLabeledComponent("Working directory:", workingDirectoryField)
            .addLabeledComponentFillVertically("Parameters (JSON object):", JBScrollPane(parametersField))
            .panel
}
