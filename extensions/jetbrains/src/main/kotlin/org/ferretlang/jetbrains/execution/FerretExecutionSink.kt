package org.ferretlang.jetbrains.execution

internal interface FerretExecutionSink {
    fun system(message: String)

    fun stdout(message: String)

    fun stderr(message: String)

    fun internal(message: String, cause: Throwable? = null)

    fun terminate(exitCode: Int)
}
