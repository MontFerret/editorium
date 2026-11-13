package org.ferretlang.jetbrains.integration

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.concurrent.thread

/** The test owns this application independently of every IDE project and launch. */
internal class WireHost private constructor(private val process: Process) : AutoCloseable {
    private val lock = ReentrantLock()
    private val changed = lock.newCondition()
    private val events = mutableListOf<JsonObject>()
    private val diagnostics = ArrayDeque<String>()
    private var streamEnded = false
    private var killed = false
    private val stderr = thread(name = "wire-host-stderr", isDaemon = true) {
        process.errorStream.bufferedReader().useLines { lines ->
            lines.forEach { line ->
                lock.withLock {
                    if (diagnostics.size == 32) diagnostics.removeFirst()
                    diagnostics.addLast(line)
                }
            }
        }
    }
    private val stdout = thread(name = "wire-host-events", isDaemon = true) {
        try {
            process.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    val event = JsonParser.parseString(line).asJsonObject
                    lock.withLock {
                        events.add(event)
                        changed.signalAll()
                    }
                }
            }
        } catch (error: Exception) {
            lock.withLock { diagnostics.addLast(error.toString()) }
        } finally {
            lock.withLock {
                streamEnded = true
                changed.signalAll()
            }
        }
    }

    fun configure(path: Path, default: String = "App"): Path {
        val endpoint = await("ready").get("endpoint").asString
        return Files.writeString(path, """{"defaultRuntime":"$default","runtimes":[
            {"name":"App","provider":"wire","endpoint":"$endpoint","insecure":true}
        ]}""")
    }

    fun count(event: String): Int = lock.withLock { events.count { it.get("event").asString == event } }

    fun await(event: String, ordinal: Int = 1, id: Int? = null, token: String? = null): JsonObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        lock.withLock {
            while (true) {
                events.asSequence().filter { item ->
                    item.get("event").asString == event && (id == null || item.get("id")?.asInt == id) &&
                        (token == null || item.get("token")?.asString == token)
                }.elementAtOrNull(ordinal - 1)?.let { return it }
                val remaining = deadline - System.nanoTime()
                check(remaining > 0 && !streamEnded) {
                    "Missing $event #$ordinal (id=$id, token=$token); events=$events; stderr=$diagnostics"
                }
                changed.awaitNanos(remaining)
            }
        }
    }

    fun connection(ordinal: Int): Int = await("connected", ordinal).get("id").asInt

    fun released(id: Int) {
        await("released", id = id)
        check(count("engineClosed") == 0) { "Application engine closed during editor cleanup" }
    }

    fun kill() {
        killed = true
        process.destroyForcibly()
        check(process.waitFor(10, TimeUnit.SECONDS)) { "Wire host did not exit" }
    }

    override fun close() {
        try {
            if (!killed) {
                process.outputStream.close()
                check(process.waitFor(10, TimeUnit.SECONDS)) { "Wire host shutdown timed out" }
            }
        } finally {
            if (process.isAlive) kill()
            stdout.join(5000)
            stderr.join(5000)
        }
        check(!stdout.isAlive && !stderr.isAlive) { "Wire host pipes did not close" }
        if (!killed) {
            check(process.exitValue() == 0) { "Wire host failed: $diagnostics" }
            await("engineClosed")
            check(count("engineClosed") == 1)
        }
    }

    companion object {
        fun start(root: Path): WireHost {
            val binary = requireNotNull(System.getenv("FERRET_TEST_WIRE_HOST")) { "Missing built Wire host" }
            val host = WireHost(ProcessBuilder(binary, "-root", root.toString()).start())
            try {
                host.await("ready")
                return host
            } catch (failure: Throwable) {
                runCatching { host.close() }.exceptionOrNull()?.let(failure::addSuppressed)
                throw failure
            }
        }
    }
}
