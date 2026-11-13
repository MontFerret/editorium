package org.ferretlang.jetbrains.runtime

import java.nio.file.Path

/** Catalog metadata used only while starting an independent DAP session. */
internal class FerretDebugRuntime(
    val descriptor: FerretRuntimeDescriptor,
    val configFile: Path?,
    val verifyConfiguration: suspend () -> Unit,
) {
    companion object {
        val LOCAL = FerretDebugRuntime(FerretRuntimeDescriptor.LOCAL, null) {}
    }
}
