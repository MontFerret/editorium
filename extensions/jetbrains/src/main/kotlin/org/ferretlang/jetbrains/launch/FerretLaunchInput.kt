package org.ferretlang.jetbrains.launch

import org.ferretlang.jetbrains.run.FerretParameterBindings
import java.nio.file.Path

internal data class FerretLaunchInput(
    val sourcePath: String,
    val workingDirectory: String,
    val projectBasePath: String?,
    val bindings: FerretParameterBindings,
)

internal data class FerretResolvedLaunchInput(
    val source: Path,
    val workspaceRoot: Path,
    val workingDirectory: Path?,
    val bindings: FerretParameterBindings,
)

internal class FerretLaunchException(message: String, cause: Throwable? = null) : Exception(message, cause)
