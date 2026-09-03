package org.ferretlang.jetbrains.execution

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FerretExecutionHandleTest {
    @Test
    fun cancellationAndTerminalOutcomeUseFirstCommittedState() {
        val cancelled = FerretExecutionHandle()
        assertTrue(cancelled.cancel())
        assertFalse(cancelled.cancel())
        assertTrue(cancelled.claimCancelRpc())
        assertFalse(cancelled.claimCancelRpc())
        assertEquals(130, cancelled.commit(0))

        val completed = FerretExecutionHandle()
        assertEquals(0, completed.commit(0))
        assertFalse(completed.cancel())
        assertEquals(0, completed.commit(1))
    }
}
