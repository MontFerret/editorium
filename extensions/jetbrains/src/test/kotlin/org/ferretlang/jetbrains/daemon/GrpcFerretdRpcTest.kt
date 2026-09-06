package org.ferretlang.jetbrains.daemon

import org.ferretlang.jetbrains.execution.FerretdExecutionOptions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class GrpcFerretdRpcTest {
    @Test
    fun mapsWorkingDirectoryOnlyWhenPresent() {
        val absent = GrpcFerretdRpc.toProtocolExecutionOptions(
            FerretdExecutionOptions("application/json", null),
        )
        assertEquals("application/json", absent.outputContentType)
        assertFalse(absent.hasWorkingDirectory())

        val runtime = Files.createTempDirectory("ferret-grpc-runtime-").toRealPath()
        val present = GrpcFerretdRpc.toProtocolExecutionOptions(
            FerretdExecutionOptions("application/json", runtime),
        )
        assertTrue(present.hasWorkingDirectory())
        assertEquals(runtime.toString(), present.workingDirectory)
    }
}
