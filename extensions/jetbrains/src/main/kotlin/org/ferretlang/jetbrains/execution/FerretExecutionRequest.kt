package org.ferretlang.jetbrains.execution

import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.launch.FerretLaunchInputResolver
import org.ferretlang.jetbrains.launch.FerretLaunchException
import org.ferretlang.jetbrains.launch.FerretResolvedLaunchInput
import java.nio.file.Path

internal data class FerretExecutionRequest(
    val source: Path,
    val workspaceRoot: Path,
    val relativeSourcePath: String,
    val workingDirectory: Path?,
    val bindings: FerretParameterBindings,
) {
    companion object {
        fun resolve(input: FerretLaunchInput): FerretExecutionRequest = from(FerretLaunchInputResolver.resolve(input))

        fun from(input: FerretResolvedLaunchInput): FerretExecutionRequest {
            val source = input.source
            val workspaceRoot = input.workspaceRoot

            val relative = workspaceRoot.relativize(source)
            if (relative.nameCount == 0 || relative.isAbsolute || relative.any { it.toString() == ".." }) {
                throw FerretLaunchException(
                    "Cannot derive a relative Ferret source path for $source from $workspaceRoot",
                )
            }
            val protocolPath = relative.joinToString("/") { it.toString() }
            if (protocolPath.isBlank() || protocolPath.contains('\u0000') || protocolPath.contains('\\')) {
                throw FerretLaunchException("The Ferret source path is not protocol-safe: $protocolPath")
            }

            return FerretExecutionRequest(source, workspaceRoot, protocolPath, input.workingDirectory, input.bindings)
        }
    }
}
