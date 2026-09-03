package org.ferretlang.jetbrains.run

import com.intellij.execution.RunManager
import com.intellij.execution.configurations.RuntimeConfigurationError
import com.intellij.execution.impl.RunManagerImpl
import com.intellij.execution.impl.RunnerAndConfigurationSettingsImpl
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.jdom.Element
import org.junit.Assert
import java.nio.file.Files

class FerretRunConfigurationPersistenceTest : BasePlatformTestCase() {
    fun testOptionsSurviveStandardRunConfigurationSerialization() {
        val factory = FerretRunConfigurationType.getInstance().configurationFactories.single()
        val runManager = RunManager.getInstance(project) as RunManagerImpl
        val originalSettings = runManager.createConfiguration("Scrape API", factory)
            as RunnerAndConfigurationSettingsImpl
        val original = (originalSettings.configuration as FerretRunConfiguration).apply {
            sourcePath = "queries/nested/query.fql"
            workingDirectory = "runtime"
            parametersJson = """{"limit":10,"nested":{"enabled":true}}"""
        }
        val serialized = Element("configuration")

        originalSettings.writeExternal(serialized)
        val restoredSettings = RunnerAndConfigurationSettingsImpl(runManager)
        restoredSettings.readExternal(serialized, false)
        val restored = restoredSettings.configuration as FerretRunConfiguration

        assertEquals("Scrape API", restoredSettings.name)
        assertEquals(original.sourcePath, restored.sourcePath)
        assertEquals(original.workingDirectory, restored.workingDirectory)
        assertEquals(original.parameters, restored.parameters)
        assertEquals(original.parametersJson, restored.parametersJson)
        assertEquals(
            setOf("sourcePath", "workingDirectory", "parametersJson"),
            serialized.getChildren("option").mapNotNull { it.getAttributeValue("name") }.toSet(),
        )
    }

    fun testConfigurationDuplicationPreservesNameAndOptions() {
        val original = createConfiguration().apply {
            name = "Scrape API"
            sourcePath = "/queries/scrape.fql"
            workingDirectory = "/runtime"
            parameters = FerretParameterBindings.of(
                mapOf(
                    "baseUrl" to FerretParameterValue.StringValue("https://example.com"),
                ),
            )
        }

        val duplicate = original.clone() as FerretRunConfiguration

        assertNotSame(original, duplicate)
        assertEquals(original.name, duplicate.name)
        assertEquals(original.sourcePath, duplicate.sourcePath)
        assertEquals(original.workingDirectory, duplicate.workingDirectory)
        assertEquals(original.parameters, duplicate.parameters)
        assertEquals(original.parametersJson, duplicate.parametersJson)
    }

    fun testBlankParametersNormalizeToAnEmptyObject() {
        val configuration = createConfiguration()

        configuration.parametersJson = "  \n\t"

        assertSame(FerretParameterBindings.EMPTY, configuration.parameters)
        assertEquals("{}", configuration.parametersJson)
    }

    fun testInvalidJsonRestoredFromXmlRemainsAvailableToValidation() {
        val source = Files.createTempFile("ferret-run-persistence-", ".fql")

        try {
            val factory = FerretRunConfigurationType.getInstance().configurationFactories.single()
            val runManager = RunManager.getInstance(project) as RunManagerImpl
            val originalSettings = runManager.createConfiguration("Invalid bindings", factory)
                as RunnerAndConfigurationSettingsImpl
            (originalSettings.configuration as FerretRunConfiguration).apply {
                sourcePath = source.toString()
                workingDirectory = ""
                parametersJson = "{"
            }
            val serialized = Element("configuration")
            originalSettings.writeExternal(serialized)

            val restoredSettings = RunnerAndConfigurationSettingsImpl(runManager)
            restoredSettings.readExternal(serialized, false)
            val restored = restoredSettings.configuration as FerretRunConfiguration
            val error = Assert.assertThrows(RuntimeConfigurationError::class.java) {
                restored.checkConfiguration()
            }

            assertEquals("{", restored.parametersJson)
            assertTrue(error.localizedMessage.orEmpty().contains("Parameters must"))
        } finally {
            Files.deleteIfExists(source)
        }
    }

    private fun createConfiguration(): FerretRunConfiguration =
        FerretRunConfigurationType
            .getInstance()
            .configurationFactories
            .single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
}
