package org.ferretlang.jetbrains.debugger

import org.ferretlang.jetbrains.execution.FerretExecutionRequest
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.launch.FerretLaunchInputResolver
import org.ferretlang.jetbrains.run.FerretParameterBindingsJson
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class FerretLaunchParityTest {
    @Test
    fun runAndDebugShareCanonicalInputsAndPreserveAllParameterTypes() {
        val root = Files.createTempDirectory("ferret-parity-")
        val runtime = Files.createTempDirectory("ferret-parity-runtime-")
        try {
            Files.createDirectory(root.resolve("queries"))
            Files.writeString(root.resolve("queries/main.fql"), "RETURN @value")
            val bindings = FerretParameterBindingsJson.parse("""{"value":{"null":null,"boolean":true,"number":1.25,"string":"😀","array":[false,2]}}""")
            for (directory in listOf("", runtime.toString())) {
                val configured = FerretLaunchInput("queries/main.fql", directory, root.toString(), bindings)
                val resolved = FerretLaunchInputResolver.resolve(configured)
                val run = FerretExecutionRequest.resolve(configured)
                val debug = FerretDapLaunchArguments.from(resolved)
                assertEquals(run.source.toString(), debug["program"])
                assertEquals(run.workspaceRoot.toString(), debug["cwd"])
                assertEquals(run.workingDirectory?.toString(), debug["workingDirectory"])
                assertEquals("queries/main.fql", run.relativeSourcePath)
                assertSame(bindings, resolved.bindings)
                assertSame(bindings, run.bindings)
                assertSame(bindings, debug["parameters"])
            }
        } finally {
            root.toFile().deleteRecursively()
            runtime.toFile().deleteRecursively()
        }
    }
}
