package org.ferretlang.jetbrains.daemon

internal class FerretdCredentials(private val token: String) {
    fun redact(value: String): String = credentialPattern.replace(value.replace(token, "<redacted>")) { match ->
        match.groupValues[1] + "<redacted>"
    }

    fun safeCause(error: Throwable): Throwable = safeCause(error, 0)

    private fun safeCause(error: Throwable, depth: Int): Throwable = Exception(
        "${error.javaClass.simpleName}: ${redact(error.message.orEmpty())}",
        error.cause?.takeIf { depth < 8 && it !== error }?.let { safeCause(it, depth + 1) },
    ).also { safe ->
        safe.stackTrace = error.stackTrace
    }

    companion object {
        private val credentialPattern = Regex(
            "(?i)(authorization\\s*[:=]\\s*Bearer\\s+|FERRETD_AUTH_TOKEN\\s*[:=]\\s*)[A-Za-z0-9_-]+",
        )
    }
}
