package org.ferretlang.jetbrains.execution

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class FerretExecutionOutputFormatterTest {
    @Test
    fun strictlyFormatsJsonTerminalOutput() {
        assertEquals(
            "{\n  \"answer\": 42\n}",
            FerretExecutionOutputFormatter.format(
                FerretdExecutionOutput("application/json; charset=utf-8", "{\"answer\":42}".toByteArray()),
            ),
        )
    }

    @Test
    fun rejectsUnsupportedMalformedAndInvalidUtf8Output() {
        assertThrows(FerretExecutionOutputException::class.java) {
            FerretExecutionOutputFormatter.format(FerretdExecutionOutput("text/plain", "1".toByteArray()))
        }
        assertThrows(FerretExecutionOutputException::class.java) {
            FerretExecutionOutputFormatter.format(FerretdExecutionOutput("application/json", "{]".toByteArray()))
        }
        assertThrows(FerretExecutionOutputException::class.java) {
            FerretExecutionOutputFormatter.format(FerretdExecutionOutput("application/json", ByteArray(0)))
        }
        assertThrows(FerretExecutionOutputException::class.java) {
            FerretExecutionOutputFormatter.format(FerretdExecutionOutput("application/json", "1 2".toByteArray()))
        }
        assertThrows(FerretExecutionOutputException::class.java) {
            FerretExecutionOutputFormatter.format(
                FerretdExecutionOutput("application/json", byteArrayOf(0xC3.toByte(), 0x28)),
            )
        }
    }
}
