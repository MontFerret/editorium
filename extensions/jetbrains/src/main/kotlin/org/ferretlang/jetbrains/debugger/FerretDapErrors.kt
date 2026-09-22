package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.diagnostic.Logger
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException

/** Protocol errors may contain expressions and values. Only presentation may consume their messages. */
internal object FerretDapErrors {
    fun message(error: Throwable, fallback: String): String {
        val cause = unwrap(error)
        return (cause as? ResponseErrorException)?.responseError?.message?.takeIf(String::isNotBlank) ?: fallback
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
