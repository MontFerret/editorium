package org.ferretlang.jetbrains.debugger

import com.intellij.icons.AllIcons
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.breakpoints.XBreakpointHandler
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import com.intellij.xdebugger.breakpoints.XLineBreakpoint
import org.eclipse.lsp4j.debug.Breakpoint
import java.nio.file.Path

internal class FerretBreakpointHandler(
    private val session: XDebugSession,
    private val dap: FerretDapSession,
) : XBreakpointHandler<XLineBreakpoint<XBreakpointProperties<*>>>(FerretBreakpointType::class.java) {
    private val lock = Any()
    private val active = linkedMapOf<XLineBreakpoint<XBreakpointProperties<*>>, Entry>()
    private val revisions = mutableMapOf<Path, Long>()
    private var sequence = 0L
    private var collecting = false

    fun initialize() {
        synchronized(lock) { collecting = true }
        try {
            session.initBreakpoints()
        } finally {
            synchronized(lock) {
                collecting = false
                active.values.map { it.source }.distinct().forEach(::publish)
            }
        }
    }

    override fun registerBreakpoint(breakpoint: XLineBreakpoint<XBreakpointProperties<*>>) {
        synchronized(lock) {
            val file = com.intellij.openapi.vfs.VirtualFileManager.getInstance().findFileByUrl(breakpoint.fileUrl)
            val path = Path.of(file?.canonicalPath ?: FileUtil.toSystemDependentName(VfsUtilCore.urlToPath(breakpoint.fileUrl)))
                .toAbsolutePath().normalize()
            val previous = active[breakpoint]
            active[breakpoint] = Entry(previous?.key ?: ++sequence, path, FerretSourcePositions.dapLine(breakpoint.line))
            if (!collecting) {
                previous?.source?.takeIf { it != path }?.let(::publish)
                publish(path)
            }
        }
    }

    override fun unregisterBreakpoint(breakpoint: XLineBreakpoint<XBreakpointProperties<*>>, temporary: Boolean) {
        synchronized(lock) {
            val removed = active.remove(breakpoint) ?: return
            if (!collecting) publish(removed.source)
        }
    }

    fun present(batch: FerretDapBreakpoints, results: List<Breakpoint>, error: String?) {
        synchronized(lock) {
            if (revisions[batch.source] != batch.revision) return
            batch.entries.forEachIndexed { index, requested ->
                val breakpoint = active.entries.firstOrNull { it.value.key == requested.key }?.key ?: return@forEachIndexed
                val result = results.getOrNull(index)
                when {
                    error != null -> session.setBreakpointInvalid(breakpoint, error)
                    result?.isVerified == true -> {
                        session.setBreakpointVerified(breakpoint)
                        val relocated = result.line?.let { it != requested.line } == true
                        val message = listOfNotNull(
                            if (relocated) "Bound to ${result.source?.path ?: batch.source}:${result.line}." else null,
                            result.message,
                        ).joinToString(" ").takeIf(String::isNotBlank)
                        if (message != null) {
                            session.updateBreakpointPresentation(breakpoint, AllIcons.Debugger.Db_verified_breakpoint, message)
                        }
                    }
                    else -> session.updateBreakpointPresentation(
                        breakpoint, AllIcons.Debugger.Db_invalid_breakpoint,
                        result?.message ?: "No executable location was found for this breakpoint.",
                    )
                }
            }
        }
    }

    fun hit(keys: List<Long>): XLineBreakpoint<XBreakpointProperties<*>>? = synchronized(lock) {
        keys.firstNotNullOfOrNull { key -> active.entries.firstOrNull { it.value.key == key }?.key }
    }

    private fun publish(source: Path) {
        val revision = (revisions[source] ?: 0) + 1
        revisions[source] = revision
        dap.replaceBreakpoints(FerretDapBreakpoints(
            source, revision, active.values.filter { it.source == source }.map { FerretDapBreakpoint(it.key, it.line) },
        ))
    }

    private data class Entry(val key: Long, val source: Path, val line: Int)
}
