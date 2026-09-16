package org.ferretlang.jetbrains.debugger

import org.eclipse.lsp4j.debug.services.IDebugProtocolClient
import org.eclipse.lsp4j.jsonrpc.debug.DebugLauncher
import java.io.ByteArrayInputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

internal class DapTestProcess(adapter: DapTestAdapter, private val requiresForce: Boolean = false) : Process(), AutoCloseable {
    private val serverInput = PipedInputStream(65_536)
    private val clientOutput = PipedOutputStream(serverInput)
    private val clientInput = PipedInputStream(65_536)
    private val serverOutput = PipedOutputStream(clientInput)
    private val exited = CountDownLatch(1)
    private val executor = Executors.newCachedThreadPool()
    val destroyCalls = AtomicInteger()
    val forceCalls = AtomicInteger()
    private val launcher = DebugLauncher.createLauncher(
        adapter, IDebugProtocolClient::class.java, serverInput, serverOutput, executor, { it },
    )
    private val listening = launcher.startListening()

    init {
        adapter.client = launcher.remoteProxy
        executor.submit {
            try { listening.get() } finally {
                runCatching { serverOutput.close() }
                if (!requiresForce) exited.countDown()
            }
        }
    }

    override fun getInputStream() = clientInput
    override fun getOutputStream() = clientOutput
    override fun getErrorStream() = ByteArrayInputStream("adapter diagnostics only\n".toByteArray())
    override fun waitFor(): Int { exited.await(); return 0 }
    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = exited.await(timeout, unit)
    override fun exitValue(): Int { check(!isAlive); return 0 }
    override fun isAlive(): Boolean = exited.count != 0L
    override fun destroy() { destroyCalls.incrementAndGet(); if (!requiresForce) close() }
    override fun destroyForcibly(): Process { forceCalls.incrementAndGet(); close(); return this }

    fun malformed() {
        synchronized(serverOutput) {
            serverOutput.write("Content-Length: 1\r\n\r\n{".toByteArray())
            serverOutput.flush()
        }
    }

    override fun close() {
        runCatching { clientOutput.close() }
        runCatching { serverOutput.close() }
        runCatching { serverInput.close() }
        runCatching { clientInput.close() }
        exited.countDown()
        listening.cancel(true)
        executor.shutdownNow()
    }
}
