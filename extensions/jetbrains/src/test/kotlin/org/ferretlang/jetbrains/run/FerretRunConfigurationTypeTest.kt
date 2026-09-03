package org.ferretlang.jetbrains.run

import com.intellij.execution.actions.RunConfigurationProducer
import com.intellij.execution.configurations.ConfigurationType
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.ferretlang.jetbrains.lang.FerretIcons

class FerretRunConfigurationTypeTest : BasePlatformTestCase() {
    fun testPluginRegistersTheFerretConfigurationTypeAndProducer() {
        val types = ConfigurationType.CONFIGURATION_TYPE_EP.extensionList

        assertTrue(types.any { it is FerretRunConfigurationType })
        assertTrue(
            RunConfigurationProducer.EP_NAME.extensionList.any {
                it is FerretRunConfigurationProducer
            },
        )
    }

    fun testConfigurationTypeUsesFerretPresentationAndSingleFactory() {
        val type = FerretRunConfigurationType.getInstance()

        assertEquals(FerretRunConfigurationType.ID, type.id)
        assertEquals("Ferret", type.displayName)
        assertEquals("Runs a Ferret Query Language source file", type.configurationTypeDescription)
        assertSame(FerretIcons.FILE, type.icon)
        assertEquals(1, type.configurationFactories.size)
        assertTrue(type.configurationFactories.single() is FerretRunConfigurationFactory)
    }

    fun testFactoryCreatesSensibleManualDefaults() {
        val configuration = createConfiguration()

        assertEquals("Ferret", configuration.name)
        assertEquals("", configuration.sourcePath)
        assertEquals(project.basePath.orEmpty(), configuration.workingDirectory)
        assertSame(FerretParameterBindings.EMPTY, configuration.parameters)
        assertEquals("{}", configuration.parametersJson)
    }

    private fun createConfiguration(): FerretRunConfiguration =
        FerretRunConfigurationType
            .getInstance()
            .configurationFactories
            .single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
}
