package org.ferretlang.jetbrains.run

import com.intellij.execution.RunManager
import com.intellij.execution.impl.RunManagerImpl
import com.intellij.execution.impl.RunnerAndConfigurationSettingsImpl
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.jdom.Element

class FerretRunConfigurationPersistenceTest : BasePlatformTestCase() {
    fun testOptionsSurviveStandardRunConfigurationSerialization() {
        val factory = FerretRunConfigurationType.getInstance().configurationFactories.single()
        val runManager = RunManager.getInstance(project) as RunManagerImpl
        val originalSettings = runManager.createConfiguration("Scrape API", factory)
            as RunnerAndConfigurationSettingsImpl
        val original = (originalSettings.configuration as FerretRunConfiguration).apply {
            sourcePath = "queries/nested/query.fql"
            workingDirectory = "runtime"
            parameters = """{"limit":10,"nested":{"enabled":true}}"""
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
        assertEquals(
            setOf("sourcePath", "workingDirectory", "parameters"),
            serialized.getChildren("option").mapNotNull { it.getAttributeValue("name") }.toSet(),
        )
    }

    fun testConfigurationDuplicationPreservesNameAndOptions() {
        val original = createConfiguration().apply {
            name = "Scrape API"
            sourcePath = "/queries/scrape.fql"
            workingDirectory = "/runtime"
            parameters = """{"baseUrl":"https://example.com"}"""
        }

        val duplicate = original.clone() as FerretRunConfiguration

        assertNotSame(original, duplicate)
        assertEquals(original.name, duplicate.name)
        assertEquals(original.sourcePath, duplicate.sourcePath)
        assertEquals(original.workingDirectory, duplicate.workingDirectory)
        assertEquals(original.parameters, duplicate.parameters)
    }

    fun testBlankParametersNormalizeToAnEmptyObject() {
        val configuration = createConfiguration()

        configuration.parameters = "  \n\t"

        assertEquals("{}", configuration.parameters)
    }

    private fun createConfiguration(): FerretRunConfiguration =
        FerretRunConfigurationType
            .getInstance()
            .configurationFactories
            .single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
}
