package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.diagnostic.Logger
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.ferretlang.jetbrains.runtime.FerretRuntimeDescriptor
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException

/** Protocol errors may contain expressions and values. Only presentation may consume their messages. */
internal object FerretDapErrors {
    fun message(error: Throwable, fallback: String): String {
        val cause = unwrap(error)
        return (cause as? ResponseErrorException)?.responseError?.message?.takeIf(String::isNotBlank) ?: fallback
    }

    fun launchFailure(error: Throwable, runtime: FerretRuntimeDescriptor): Throwable {
        val rejection = unwrap(error) as? ResponseErrorException ?: return error
        if (runtime.provider != "wire") return error
        // Wire failures can combine a public category with a transport error containing connection details.
        val message = if (rejection.responseError.message.orEmpty().contains("runtime unavailable")) {
            "Ferret runtime '${runtime.name}' is unavailable."
        } else {
            "Debug launch failed on Ferret runtime '${runtime.name}'."
        }
        return IllegalStateException(message)
    }

    fun log(operation: String, error: Throwable) {
        val cause = unwrap(error)
        val code = (cause as? ResponseErrorException)?.responseError?.code
        LOG.debug("Ferret DAP $operation failed (${cause.javaClass.simpleName}, code=$code, cause=${cause.cause?.javaClass?.simpleName})")
    }

    private fun unwrap(error: Throwable): Throwable = when (error) {
        is CompletionException, is ExecutionException -> error.cause?.let(::unwrap) ?: error
        else -> error
    }

    private val LOG = Logger.getInstance(FerretDapErrors::class.java)
}
