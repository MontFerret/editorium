package org.ferretlang.jetbrains.daemon

internal class FerretdBinaryException(
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)
