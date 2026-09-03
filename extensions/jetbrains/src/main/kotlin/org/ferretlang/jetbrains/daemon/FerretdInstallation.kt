package org.ferretlang.jetbrains.daemon

import java.nio.file.Path

internal data class FerretdInstallation(
    val executable: Path,
    val version: String,
)
