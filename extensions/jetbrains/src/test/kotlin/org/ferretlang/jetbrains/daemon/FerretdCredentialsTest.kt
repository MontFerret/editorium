package org.ferretlang.jetbrains.daemon

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FerretdCredentialsTest {
    @Test
    fun redactsBareQuotedAndLabelledCredentialsIncludingExceptionCauses() {
        val credential = "test-secret-credential"
        val credentials = FerretdCredentials(credential)
        for (value in listOf(credential, "{\"token\":\"$credential\"}", "Authorization: Bearer $credential", "FERRETD_AUTH_TOKEN=$credential")) {
            val sanitized = credentials.redact(value)
            assertFalse("The credential must not be logged", sanitized.contains(credential))
            assertTrue(sanitized.contains("<redacted>"))
        }
        val error = IllegalStateException("startup $credential", IllegalArgumentException("nested $credential"))
        assertFalse("Exception chains must not expose the credential", credentials.safeCause(error).stackTraceToString().contains(credential))
    }
}
