package org.ferretlang.jetbrains.execution

import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException
import java.nio.file.Files

class FerretExecutionRequestTest {
    @Test
    fun resolvesConfiguredAndFallbackRootsWithProtocolPaths() {
        val root = Files.createTempDirectory("ferret root ü ")
        val nested = Files.createDirectories(root.resolve("nested space"))
        val source = Files.writeString(nested.resolve("query ü.fql"), "RETURN 1")
        val configured = FerretExecutionRequest.resolve(
            FerretExecutionInput(source.toString(), root.toString(), null, FerretParameterBindings.EMPTY),
        )
        assertEquals(source.toRealPath(), configured.source)
        assertEquals(root.toRealPath(), configured.workspaceRoot)
        assertEquals("nested space/query ü.fql", configured.relativeSourcePath)

        val projectFallback = FerretExecutionRequest.resolve(
            FerretExecutionInput(source.toString(), " ", root.toString(), FerretParameterBindings.EMPTY),
        )
        assertEquals(root.toRealPath(), projectFallback.workspaceRoot)

        val parentFallback = FerretExecutionRequest.resolve(
            FerretExecutionInput(source.toString(), "", null, FerretParameterBindings.EMPTY),
        )
        assertEquals(nested.toRealPath(), parentFallback.workspaceRoot)
        assertEquals("query ü.fql", parentFallback.relativeSourcePath)
    }

    @Test
    fun rejectsSourceOutsideRootAndInvalidRoots() {
        val root = Files.createTempDirectory("ferret-root-")
        val outside = Files.writeString(Files.createTempFile("ferret-outside-", ".fql"), "RETURN 1")
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(outside.toString(), root.toString(), null, FerretParameterBindings.EMPTY),
            )
        }
        val notDirectory = Files.writeString(root.resolve("file"), "value")
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(outside.toString(), notDirectory.toString(), null, FerretParameterBindings.EMPTY),
            )
        }
    }

    @Test
    fun canonicalContainmentRejectsSymlinkEscape() {
        val root = Files.createTempDirectory("ferret-root-")
        val outside = Files.writeString(Files.createTempFile("ferret-outside-", ".fql"), "RETURN 1")
        val link = root.resolve("linked.fql")
        try {
            Files.createSymbolicLink(link, outside)
        } catch (_: IOException) {
            return
        } catch (_: SecurityException) {
            return
        } catch (_: UnsupportedOperationException) {
            return
        }
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(link.toString(), root.toString(), null, FerretParameterBindings.EMPTY),
            )
        }
    }
}
