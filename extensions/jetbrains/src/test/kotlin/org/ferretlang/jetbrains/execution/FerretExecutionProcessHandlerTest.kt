package org.ferretlang.jetbrains.execution

import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessEvent
import org.junit.Assert.*
import org.junit.Test

class FerretExecutionProcessHandlerTest {
    @Test
    fun stopBeforeAttachAndRepeatedTerminationRemainSingleShot() {
        val process = FerretExecutionProcessHandler()
        val exits = mutableListOf<Int>()
        process.addProcessListener(object : ProcessListener {
            override fun processTerminated(event: ProcessEvent) { exits += event.exitCode }
        })
        process.startNotify()
        process.destroyProcess()
        val handle = FerretExecutionHandle()
        process.attach(handle)
        assertTrue(handle.isCancellationRequested())
        process.destroyProcess()
        process.terminate(130)
        process.terminate(0)
        assertEquals(listOf(130), exits)
        assertTrue(process.isProcessTerminated)
    }

    @Test
    fun stopAfterCommittedSuccessDoesNotPrintCancellation() {
        val process = FerretExecutionProcessHandler()
        val messages = mutableListOf<String>()
        process.addProcessListener(object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: com.intellij.openapi.util.Key<*>) {
                messages += event.text
            }
        })
        process.startNotify()
        val handle = FerretExecutionHandle()
        process.attach(handle)
        assertEquals(0, handle.commit(0))
        process.destroyProcess()
        process.terminate(0)
        assertTrue(messages.isEmpty())
        assertEquals(0, process.exitCode)
    }
}
