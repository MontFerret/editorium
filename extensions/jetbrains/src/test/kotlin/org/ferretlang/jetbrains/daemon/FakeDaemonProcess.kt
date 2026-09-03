package org.ferretlang.jetbrains.daemon

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

internal class FakeDaemonProcess(stderrText: String) : Process() {
    private val stopped = CountDownLatch(1)
    private val exit = AtomicInteger()
    private val stderr = ByteArrayInputStream(stderrText.toByteArray(StandardCharsets.UTF_8))

    override fun getOutputStream(): OutputStream = ByteArrayOutputStream()

    override fun getInputStream(): InputStream = ByteArrayInputStream(ByteArray(0))

    override fun getErrorStream(): InputStream = stderr

    override fun waitFor(): Int {
        stopped.await()
        return exit.get()
    }

    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean {
        stopped.countDown()
        return true
    }

    override fun exitValue(): Int {
        if (stopped.count != 0L) throw IllegalThreadStateException()
        return exit.get()
    }

    override fun destroy() {
        stopped.countDown()
    }

    override fun destroyForcibly(): Process {
        exit.set(137)
        stopped.countDown()
        return this
    }

    override fun isAlive(): Boolean = stopped.count != 0L

    fun crash(exitCode: Int) {
        exit.set(exitCode)
        stopped.countDown()
    }

    companion object {
        fun ready(version: String, port: Int = 43123): FakeDaemonProcess = FakeDaemonProcess(
            "{\"event\":\"ferretd.ready\",\"endpoint\":\"tcp://127.0.0.1:$port\"," +
                "\"version\":\"$version\",\"message\":\"ferretd started\"}\n",
        )
    }
}
