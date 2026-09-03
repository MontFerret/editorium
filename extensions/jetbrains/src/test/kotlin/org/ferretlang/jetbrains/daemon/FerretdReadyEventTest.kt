package org.ferretlang.jetbrains.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class FerretdReadyEventTest {
    @Test
    fun parsesOnlyTheAuthenticatedLoopbackReadinessContract() {
        assertNull(FerretdReadyEvent.parse("not json", "1.0.0-alpha.5"))
        assertNull(FerretdReadyEvent.parse("{\"event\":\"log\"}", "1.0.0-alpha.5"))
        val ready = FerretdReadyEvent.parse(
            "{\"level\":\"info\",\"event\":\"ferretd.ready\",\"endpoint\":\"tcp://127.0.0.1:32123\"," +
                "\"version\":\"1.0.0-alpha.5\",\"message\":\"ferretd started\"}",
            "1.0.0-alpha.5",
        )
        assertEquals(32123, ready?.port)
        assertThrows(FerretdConnectionException::class.java) {
            FerretdReadyEvent.parse(
                "{\"event\":\"ferretd.ready\",\"endpoint\":\"tcp://localhost:1\"," +
                    "\"version\":\"1.0.0-alpha.5\",\"message\":\"ferretd started\"}",
                "1.0.0-alpha.5",
            )
        }
        assertThrows(FerretdConnectionException::class.java) {
            FerretdReadyEvent.parse(
                "{\"event\":\"ferretd.ready\",\"endpoint\":\"tcp://127.0.0.1:1\"," +
                    "\"version\":\"wrong\",\"message\":\"ferretd started\"}",
                "1.0.0-alpha.5",
            )
        }
    }
}
