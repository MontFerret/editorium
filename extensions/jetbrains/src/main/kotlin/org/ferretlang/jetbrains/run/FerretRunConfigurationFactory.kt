package org.ferretlang.jetbrains.run

import com.intellij.execution.configurations.ConfigurationFactory
import com.intellij.execution.configurations.ConfigurationType
import com.intellij.execution.configurations.RunConfiguration
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.project.Project

class FerretRunConfigurationFactory(
    type: ConfigurationType,
) : ConfigurationFactory(type) {
    override fun getId(): String = FerretRunConfigurationType.ID

    override fun createTemplateConfiguration(project: Project): RunConfiguration =
        FerretRunConfiguration(project, this, FerretRunConfigurationType.DISPLAY_NAME).apply {
            workingDirectory = project.basePath.orEmpty()
        }

    override fun getOptionsClass(): Class<out BaseState> = FerretRunConfigurationOptions::class.java

    override fun isEditableInDumbMode(): Boolean = true
}
