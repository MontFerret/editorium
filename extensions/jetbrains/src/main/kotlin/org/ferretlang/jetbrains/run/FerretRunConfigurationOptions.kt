package org.ferretlang.jetbrains.run

import com.intellij.execution.configurations.LocatableRunConfigurationOptions

class FerretRunConfigurationOptions : LocatableRunConfigurationOptions() {
    var sourcePath by string("")
    var workingDirectory by string("")
    var parameters by string("{}")
}
