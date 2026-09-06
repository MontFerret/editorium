package org.ferretlang.jetbrains.execution

import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assume.assumeFalse
import org.junit.Test
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission

class FerretExecutionRequestTest {
    @Test
    fun separatesProjectWorkspaceFromRelativeRuntimeDirectory() {
        val project = Files.createTempDirectory("ferret project ü ")
        val queries = Files.createDirectories(project.resolve("queries space"))
        val runtime = Files.createDirectories(project.resolve("runtime ü"))
        val source = Files.writeString(queries.resolve("query ü.fql"), "RETURN 1")

        val request = FerretExecutionRequest.resolve(
            FerretExecutionInput(
                "queries space/query ü.fql",
                "runtime ü",
                project.toString(),
                FerretParameterBindings.EMPTY,
            ),
        )

        assertEquals(source.toRealPath(), request.source)
        assertEquals(project.toRealPath(), request.workspaceRoot)
        assertEquals("queries space/query ü.fql", request.relativeSourcePath)
        assertEquals(runtime.toRealPath(), request.workingDirectory)
    }

    @Test
    fun blankWorkingDirectoryIsOmittedAndWorkspaceFallsBackOnlyWithoutProjectBase() {
        val project = Files.createTempDirectory("ferret-project-")
        val nested = Files.createDirectories(project.resolve("nested"))
        val source = Files.writeString(nested.resolve("query.fql"), "RETURN 1")

        val projectRequest = FerretExecutionRequest.resolve(
            FerretExecutionInput(source.toString(), " ", project.toString(), FerretParameterBindings.EMPTY),
        )
        assertEquals(project.toRealPath(), projectRequest.workspaceRoot)
        assertEquals("nested/query.fql", projectRequest.relativeSourcePath)
        assertNull(projectRequest.workingDirectory)

        val parentRequest = FerretExecutionRequest.resolve(
            FerretExecutionInput(source.toString(), "", null, FerretParameterBindings.EMPTY),
        )
        assertEquals(nested.toRealPath(), parentRequest.workspaceRoot)
        assertEquals("query.fql", parentRequest.relativeSourcePath)
        assertNull(parentRequest.workingDirectory)
    }

    @Test
    fun acceptsWorkingDirectoryOutsideWorkspaceAndSourceOutsideWorkingDirectory() {
        val project = Files.createTempDirectory("ferret-project-")
        val source = Files.writeString(project.resolve("query.fql"), "RETURN 1")
        val runtime = Files.createTempDirectory("ferret-external-runtime-")

        val request = FerretExecutionRequest.resolve(
            FerretExecutionInput(
                source.toString(),
                runtime.toString(),
                project.toString(),
                FerretParameterBindings.EMPTY,
            ),
        )

        assertEquals(project.toRealPath(), request.workspaceRoot)
        assertEquals(runtime.toRealPath(), request.workingDirectory)
    }

    @Test
    fun rejectsInvalidOrNoncontainingProjectBaseWithoutFallingBack() {
        val source = Files.writeString(Files.createTempFile("ferret-outside-", ".fql"), "RETURN 1")
        val project = Files.createTempDirectory("ferret-project-")
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(source.toString(), "", project.toString(), FerretParameterBindings.EMPTY),
            )
        }

        val missing = project.resolve("missing")
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(source.toString(), "", missing.toString(), FerretParameterBindings.EMPTY),
            )
        }

        val file = Files.writeString(project.resolve("not-a-directory"), "value")
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(source.toString(), "", file.toString(), FerretParameterBindings.EMPTY),
            )
        }

        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(source.toString(), "", "", FerretParameterBindings.EMPTY),
            )
        }
    }

    @Test
    fun rejectsRelativeWorkingDirectoryWithoutProjectBaseAndInvalidRuntimePaths() {
        val source = Files.writeString(Files.createTempFile("ferret-source-", ".fql"), "RETURN 1")
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(source.toString(), "runtime", null, FerretParameterBindings.EMPTY),
            )
        }

        val file = Files.writeString(Files.createTempFile("ferret-runtime-file-", ".txt"), "value")
        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(source.toString(), file.toString(), null, FerretParameterBindings.EMPTY),
            )
        }

        assertThrows(FerretExecutionRequestException::class.java) {
            FerretExecutionRequest.resolve(
                FerretExecutionInput(
                    source.toString(),
                    file.resolveSibling("missing").toString(),
                    null,
                    FerretParameterBindings.EMPTY,
                ),
            )
        }
    }

    @Test
    fun canonicalContainmentRejectsSourceSymlinkEscape() {
        val project = Files.createTempDirectory("ferret-project-")
        val outside = Files.writeString(Files.createTempFile("ferret-outside-", ".fql"), "RETURN 1")
        val link = project.resolve("linked.fql")
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
                FerretExecutionInput(link.toString(), "", project.toString(), FerretParameterBindings.EMPTY),
            )
        }
    }

    @Test
    fun canonicalizesASymlinkedWorkingDirectoryOutsideTheWorkspace() {
        val project = Files.createTempDirectory("ferret-project-")
        val source = Files.writeString(project.resolve("query.fql"), "RETURN 1")
        val runtime = Files.createTempDirectory("ferret-runtime-target-")
        val link = project.resolve("runtime-link")
        try {
            Files.createSymbolicLink(link, runtime)
        } catch (_: IOException) {
            return
        } catch (_: SecurityException) {
            return
        } catch (_: UnsupportedOperationException) {
            return
        }

        val request = FerretExecutionRequest.resolve(
            FerretExecutionInput(source.toString(), link.toString(), project.toString(), FerretParameterBindings.EMPTY),
        )

        assertEquals(runtime.toRealPath(), request.workingDirectory)
    }

    @Test
    fun rejectsAnUnreadableWorkingDirectoryWhenThePlatformExposesPermissions() {
        val project = Files.createTempDirectory("ferret-project-")
        val source = Files.writeString(project.resolve("query.fql"), "RETURN 1")
        val runtime = Files.createTempDirectory("ferret-unreadable-runtime-")
        val permissions = try {
            Files.getPosixFilePermissions(runtime)
        } catch (_: UnsupportedOperationException) {
            return
        }
        try {
            Files.setPosixFilePermissions(runtime, emptySet<PosixFilePermission>())
            assumeFalse(Files.isReadable(runtime))
            assertThrows(FerretExecutionRequestException::class.java) {
                FerretExecutionRequest.resolve(
                    FerretExecutionInput(
                        source.toString(),
                        runtime.toString(),
                        project.toString(),
                        FerretParameterBindings.EMPTY,
                    ),
                )
            }
        } finally {
            Files.setPosixFilePermissions(runtime, permissions)
        }
    }
}
