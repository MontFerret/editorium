package org.ferretlang.jetbrains.daemon

internal class FerretdProcessException(
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)
