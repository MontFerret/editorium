package org.ferretlang.jetbrains.run

import com.intellij.openapi.options.ConfigurationException
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.UIUtil
import org.junit.Assert
import java.awt.Container

class FerretRunConfigurationEditorTest : BasePlatformTestCase() {
    fun testParametersEditorGrowsWithTheNativeSettingsPanel() {
        val editor = FerretRunConfigurationEditor(project)
        try {
            val component = editor.component
            component.setSize(component.preferredSize)
            layout(component)
            val field = parametersField(editor)
            val original = field.size
            component.setSize(component.width + 200, component.height + 150)
            layout(component)
            assertTrue(field.width > original.width)
            assertTrue(field.height > original.height)
        } finally {
            editor.dispose()
        }
    }

    fun testEditorAppliesJsonAsSemanticBindingsAndPreservesValidFormatting() {
        val configuration = createConfiguration()
        val editor = FerretRunConfigurationEditor(project)

        try {
            val parametersField = parametersField(editor)
            editor.resetFrom(configuration)
            parametersField.text = """{
  "limit": 10,
  "nested": { "enabled": true }
}"""

            editor.applyTo(configuration)

            assertEquals(FerretParameterValue.NumberValue(10.0), configuration.parameters.entries["limit"])
            assertEquals(parametersField.text, configuration.parametersJson)
        } finally {
            editor.dispose()
        }
    }

    fun testEditorRejectsInvalidJsonBeforeChangingTheConfiguration() {
        val configuration = createConfiguration().apply {
            sourcePath = "original.fql"
            workingDirectory = "original"
            parameters = FerretParameterBindings.of(
                mapOf("value" to FerretParameterValue.BooleanValue(true)),
            )
        }
        val editor = FerretRunConfigurationEditor(project)

        try {
            val parametersField = parametersField(editor)
            editor.resetFrom(configuration)
            parametersField.text = "["

            Assert.assertThrows(ConfigurationException::class.java) {
                editor.applyTo(configuration)
            }

            assertEquals("original.fql", configuration.sourcePath)
            assertEquals("original", configuration.workingDirectory)
            assertEquals(
                FerretParameterValue.BooleanValue(true),
                configuration.parameters.entries["value"],
            )
        } finally {
            editor.dispose()
        }
    }

    private fun parametersField(editor: FerretRunConfigurationEditor): JBTextArea =
        requireNotNull(UIUtil.findComponentOfType(editor.component, JBTextArea::class.java))

    private fun layout(container: Container) {
        container.doLayout()
        container.components.filterIsInstance<Container>().forEach(::layout)
    }

    private fun createConfiguration(): FerretRunConfiguration =
        FerretRunConfigurationType
            .getInstance()
            .configurationFactories
            .single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
}
