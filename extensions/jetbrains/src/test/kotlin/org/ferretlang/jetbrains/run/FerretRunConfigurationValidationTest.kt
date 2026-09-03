package org.ferretlang.jetbrains.run

import com.intellij.execution.configurations.RuntimeConfigurationError
import com.intellij.openapi.project.ProjectManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.junit.Assert
import java.nio.file.Files
import java.nio.file.Path

class FerretRunConfigurationValidationTest : BasePlatformTestCase() {
    private lateinit var temporaryRoot: Path

    override fun setUp() {
        super.setUp()
        temporaryRoot = Files.createTempDirectory("ferret-run-configuration-")
    }

    override fun tearDown() {
        try {
            temporaryRoot.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    fun testAcceptsAbsolutePathsWithJsonObjectBindings() {
        val source = createSource("nested/query.fql")
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
            workingDirectory = source.parent.toString()
            parameters = """{"limit":10,"nested":{"values":[true,null,1.5]}}"""
        }

        configuration.checkConfiguration()
    }

    fun testResolvesProjectRelativePathsAgainstTheProjectBaseDirectory() {
        val configuration = createConfiguration().apply {
            sourcePath = "nested/query.fql"
            workingDirectory = "runtime"
        }

        val projectBase = Path.of(requireNotNull(project.basePath))

        assertEquals(projectBase.resolve("nested/query.fql").normalize(), configuration.resolvedSourcePathOrNull())
        assertEquals(projectBase.resolve("runtime").normalize(), configuration.resolvedWorkingDirectoryOrNull())
    }

    fun testAcceptsAnEmptyWorkingDirectoryAndBlankBindings() {
        val source = createSource()
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
            workingDirectory = ""
            parameters = ""
        }

        configuration.checkConfiguration()

        assertEquals("{}", configuration.parameters)
    }

    fun testRejectsMissingSourcePath() {
        val error = configurationError(createConfiguration())

        assertEquals("Set the Ferret source file.", error.localizedMessage)
    }

    fun testRejectsMalformedSourcePath() {
        val configuration = createConfiguration().apply {
            sourcePath = "bad\u0000path.fql"
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("source file path is invalid"))
    }

    fun testRejectsNonexistentSourcePath() {
        val configuration = createConfiguration().apply {
            sourcePath = temporaryRoot.resolve("missing.fql").toString()
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("source file does not exist"))
    }

    fun testRejectsSourceDirectory() {
        val configuration = createConfiguration().apply {
            sourcePath = Files.createDirectories(temporaryRoot.resolve("queries")).toString()
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("source path is not a file"))
    }

    fun testRejectsUnsupportedSourceFileType() {
        val source = createSource("query.txt")
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("must use the .fql extension"))
    }

    fun testRejectsNonexistentWorkingDirectory() {
        val source = createSource()
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
            workingDirectory = temporaryRoot.resolve("missing-directory").toString()
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("working directory does not exist"))
    }

    fun testRejectsWorkingDirectoryFile() {
        val source = createSource()
        val workingFile = Files.writeString(temporaryRoot.resolve("working.txt"), "not a directory")
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
            workingDirectory = workingFile.toString()
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("working directory path is not a directory"))
    }

    fun testRejectsMalformedWorkingDirectory() {
        val source = createSource()
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
            workingDirectory = "bad\u0000directory"
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("working directory path is invalid"))
    }

    fun testRejectsRelativePathsWithoutAProjectBaseDirectory() {
        val defaultProject = ProjectManager.getInstance().defaultProject
        assertNull(defaultProject.basePath)
        val configuration = FerretRunConfiguration(
            defaultProject,
            FerretRunConfigurationType.getInstance().configurationFactories.single(),
            "Ferret",
        ).apply {
            sourcePath = "query.fql"
            workingDirectory = ""
        }

        val error = configurationError(configuration)

        assertTrue(error.localizedMessage.orEmpty().contains("must be absolute because the project has no base directory"))
    }

    fun testRejectsMalformedAndNonObjectBindings() {
        val source = createSource()
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
            workingDirectory = ""
        }

        for (parameters in listOf("{", "[]", "null", "true", "\"value\"")) {
            configuration.parameters = parameters
            val error = configurationError(configuration)
            assertTrue(error.localizedMessage.orEmpty().contains("Parameters must"))
        }
    }

    fun testRejectsNonFiniteBindings() {
        val source = createSource()
        val configuration = createConfiguration().apply {
            sourcePath = source.toString()
            workingDirectory = ""
            parameters = """{"value":1e400}"""
        }

        val error = configurationError(configuration)

        assertEquals("Parameters must contain only finite JSON numbers.", error.localizedMessage)
    }

    private fun createConfiguration(): FerretRunConfiguration =
        FerretRunConfigurationType
            .getInstance()
            .configurationFactories
            .single()
            .createTemplateConfiguration(project) as FerretRunConfiguration

    private fun createSource(relativePath: String = "query.fql"): Path {
        val source = temporaryRoot.resolve(relativePath)
        Files.createDirectories(source.parent)
        return Files.writeString(source, "RETURN 1")
    }

    private fun configurationError(configuration: FerretRunConfiguration): RuntimeConfigurationError =
        Assert.assertThrows(RuntimeConfigurationError::class.java) {
            configuration.checkConfiguration()
        }
}
