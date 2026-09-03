package org.ferretlang.jetbrains.run

import com.intellij.execution.configurations.ConfigurationTypeBase
import com.intellij.execution.configurations.ConfigurationTypeUtil
import com.intellij.openapi.project.DumbAware
import org.ferretlang.jetbrains.lang.FerretIcons

class FerretRunConfigurationType : ConfigurationTypeBase(
    ID,
    DISPLAY_NAME,
    "Runs a Ferret Query Language source file",
    FerretIcons.FILE,
), DumbAware {
    init {
        addFactory(FerretRunConfigurationFactory(this))
    }

    companion object {
        const val ID = "FerretRunConfiguration"
        const val DISPLAY_NAME = "Ferret"

        fun getInstance(): FerretRunConfigurationType =
            ConfigurationTypeUtil.findConfigurationType(FerretRunConfigurationType::class.java)
    }
}
