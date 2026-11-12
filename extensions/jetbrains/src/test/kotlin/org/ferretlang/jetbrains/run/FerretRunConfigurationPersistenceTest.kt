package org.ferretlang.jetbrains.run

import com.intellij.execution.RunManager
import com.intellij.execution.configurations.RuntimeConfigurationError
import com.intellij.execution.impl.RunManagerImpl
import com.intellij.execution.impl.RunnerAndConfigurationSettingsImpl
import com.intellij.openapi.util.InvalidDataException
import com.intellij.openapi.util.JDOMUtil
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

        assertEquals("", restored.runtimeName)
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

    fun testRuntimeSelectionRoundTripsThroughEditorSerializationAndDuplication() {
        val manager = RunManager.getInstance(project) as RunManagerImpl
        val factory = FerretRunConfigurationType.getInstance().configurationFactories.single()
        for (name in listOf("", "local", "MyApplication", "removed", "应用 🦦 <&\"", "🦦")) {
            val settings = manager.createConfiguration("runtime", factory) as RunnerAndConfigurationSettingsImpl
            val config = settings.configuration as FerretRunConfiguration
            config.runtimeName = name
            config.workingDirectory = """  C:\Runtime 🦦 Host\data  """
            val editor = FerretRunConfigurationEditor(project)
            try {
                editor.resetFrom(config)
                editor.applyTo(config)
                assertEquals(name, config.launchInput().runtimeName)
            } finally {
                com.intellij.openapi.util.Disposer.dispose(editor)
            }
            val xml = Element("configuration")
            settings.writeExternal(xml)
            val copy = RunnerAndConfigurationSettingsImpl(manager)
            copy.readExternal(JDOMUtil.load(JDOMUtil.writeElement(xml)), false)
            val restored = copy.configuration as FerretRunConfiguration
            assertEquals("""  C:\Runtime 🦦 Host\data  """, restored.workingDirectory)
            assertEquals(name, restored.runtimeName)
            assertEquals(name, (restored.clone() as FerretRunConfiguration).runtimeName)
        }
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

    fun testLiteralRuntimeFieldsRoundTripAlongsideAMacroAwareSource() {
        val manager = RunManager.getInstance(project) as RunManagerImpl
        val factory = FerretRunConfigurationType.getInstance().configurationFactories.single()
        val settings = manager.createConfiguration("literal fields", factory) as RunnerAndConfigurationSettingsImpl
        val config = settings.configuration as FerretRunConfiguration
        val base = requireNotNull(project.basePath)
        config.sourcePath = "$base/query.fql"
        val plain = listOf("", "local", "WireApp", "services/demo-data", "base64url-utf8-v1")
        val encoded = listOf("\$PROJECT_DIR\$/remote", "$base/remote", """C:\App\data""", """\\server\share""",
            " services/app  ", "应用 🦦", "base64url-utf8-v1:V2lyZQ")
        for (value in plain + encoded) {
            config.runtimeName = value
            config.workingDirectory = value
            val xml = Element("configuration")
            settings.writeExternal(xml)
            val options = xml.getChildren("option")
            assertEquals("\$PROJECT_DIR\$/query.fql", options.single { it.getAttributeValue("name") == "sourcePath" }.getAttributeValue("value"))
            for (name in listOf("runtimeName", "workingDirectory")) {
                val entries = options.filter { it.getAttributeValue("name") == name }
                if (value.isEmpty()) {
                    assertEmpty(entries)
                } else {
                    val entry = entries.single()
                    if (value in plain) {
                        assertNull(entry.getAttribute("ferretEncoding"))
                        assertEquals(value, entry.getAttributeValue("value"))
                    } else {
                        assertEquals("base64url-utf8-v1", entry.getAttributeValue("ferretEncoding"))
                        assertTrue(entry.getAttributeValue("value").matches(Regex("[A-Za-z0-9_-]+")))
                    }
                }
            }
            val restored = RunnerAndConfigurationSettingsImpl(manager)
            restored.readExternal(JDOMUtil.load(JDOMUtil.writeElement(xml)), false)
            val reopened = restored.configuration as FerretRunConfiguration
            for (copy in listOf(reopened, reopened.clone() as FerretRunConfiguration)) {
                assertEquals(value, copy.runtimeName)
                assertEquals(value, copy.workingDirectory)
                assertEquals(config.sourcePath, copy.sourcePath)
            }
        }
    }

    fun testLegacyOptionsKeepTheirMacroInterpretationOnLoadAndResave() {
        val manager = RunManager.getInstance(project) as RunManagerImpl
        val settings = RunnerAndConfigurationSettingsImpl(manager)
        val macroPath = "\$PROJECT_DIR\$/runtime"
        val xml = JDOMUtil.load("""
            <configuration name="Legacy" type="FerretRunConfiguration">
              <option name="runtimeName" value="base64url-utf8-v1:V2lyZQ"/>
              <option name="workingDirectory" value="$macroPath"/>
            </configuration>
        """.trimIndent())
        settings.readExternal(xml, false)
        val saved = Element("configuration")
        settings.writeExternal(saved)
        val reopened = RunnerAndConfigurationSettingsImpl(manager)
        reopened.readExternal(JDOMUtil.load(JDOMUtil.writeElement(saved)), false)
        for (item in listOf(settings, reopened)) {
            val config = item.configuration as FerretRunConfiguration
            assertEquals("base64url-utf8-v1:V2lyZQ", config.runtimeName)
            assertEquals(requireNotNull(project.basePath) + "/runtime", config.workingDirectory)
        }
    }

    fun testRejectsUnknownEncodingAndMalformedMarkedValuesAtLoad() {
        val manager = RunManager.getInstance(project) as RunManagerImpl
        for (name in listOf("runtimeName", "workingDirectory")) {
            for ((encoding, payload) in listOf("unknown" to "YQ", "base64url-utf8-v1" to "!",
                "base64url-utf8-v1" to "YQ==", "base64url-utf8-v1" to "_w")) {
                val xml = JDOMUtil.load("""
                    <configuration name="Broken" type="FerretRunConfiguration">
                      <option name="$name" value="$payload" ferretEncoding="$encoding"/>
                    </configuration>
                """.trimIndent())
                val error = Assert.assertThrows(InvalidDataException::class.java) {
                    RunnerAndConfigurationSettingsImpl(manager).readExternal(xml, false)
                }
                assertTrue(error.message.orEmpty().contains(name))
            }
        }
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
