package org.ferretlang.jetbrains.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class FakeDaemonProcessTest {
    @Test
    fun zeroTimeoutDoesNotTerminateRunningProcess() = assertTimeoutPreservesRunningProcess(0)

    @Test
    fun negativeTimeoutDoesNotTerminateRunningProcess() = assertTimeoutPreservesRunningProcess(-1)

    @Test
    fun elapsedTimeoutDoesNotTerminateRunningProcess() = assertTimeoutPreservesRunningProcess(10)

    @Test
    fun destructionReleasesWaiters() = assertExitReleasesWaiters(0) { it.destroy() }

    @Test
    fun forcedDestructionReleasesWaiters() = assertExitReleasesWaiters(137) { it.destroyForcibly() }

    @Test
    fun crashReleasesWaiters() = assertExitReleasesWaiters(17) { it.crash(17) }

    private fun assertTimeoutPreservesRunningProcess(timeoutMillis: Long) {
        val process = FakeDaemonProcess("")
        try {
            repeat(2) {
                assertFalse(process.waitFor(timeoutMillis, TimeUnit.MILLISECONDS))
                assertTrue(process.isAlive)
                assertThrows(IllegalThreadStateException::class.java) { process.exitValue() }
            }
        } finally {
            process.destroy()
        }
    }

    private fun assertExitReleasesWaiters(exitCode: Int, stop: (FakeDaemonProcess) -> Unit) {
        val process = FakeDaemonProcess("")
        val executor = Executors.newFixedThreadPool(2)
        val waiting = CountDownLatch(2)
        try {
            val exit = executor.submit<Int> {
                waiting.countDown()
                process.waitFor()
            }
            val stopped = executor.submit<Boolean> {
                waiting.countDown()
                process.waitFor(5, TimeUnit.SECONDS)
            }
            assertTrue("Process waiters did not start", waiting.await(5, TimeUnit.SECONDS))

            stop(process)

            assertEquals(exitCode, exit.get(5, TimeUnit.SECONDS).toInt())
            assertTrue(stopped.get(5, TimeUnit.SECONDS))
            assertFalse(process.isAlive)
            assertEquals(exitCode, process.exitValue())
            assertTrue(process.waitFor(0, TimeUnit.SECONDS))
            assertTrue(process.waitFor(-1, TimeUnit.SECONDS))
            assertEquals(exitCode, process.exitValue())
        } finally {
            process.destroy()
            executor.shutdownNow()
            assertTrue("Process waiters did not stop", executor.awaitTermination(5, TimeUnit.SECONDS))
        }
    }
}
