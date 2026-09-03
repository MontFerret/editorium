package org.ferretlang.jetbrains.run

import com.intellij.execution.RunManager
import com.intellij.execution.actions.ConfigurationContext
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiManager
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.ferretlang.jetbrains.lang.FerretLanguageFileType
import java.nio.file.Files
import java.nio.file.Path

class FerretRunConfigurationProducerTest : BasePlatformTestCase() {
    private lateinit var temporaryRoot: Path

    override fun setUp() {
        super.setUp()
        temporaryRoot = Files.createTempDirectory("ferret-run-producer-")
    }

    override fun tearDown() {
        try {
            temporaryRoot.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    fun testLocalFerretContextProducesAReusableGeneratedConfiguration() {
        val file = createLocalFile("nested/query.fql")
        val context = contextFor(file)
        val producer = FerretRunConfigurationProducer()

        val produced = producer.createConfigurationFromContext(context)
        val configuration = produced?.configuration as FerretRunConfiguration

        assertEquals(file.toNioPath().toAbsolutePath().normalize().toString(), configuration.sourcePath)
        assertEquals(project.basePath.orEmpty(), configuration.workingDirectory)
        assertEquals("{}", configuration.parameters)
        assertEquals("query.fql", configuration.name)
        assertTrue(configuration.isGeneratedName)
        assertTrue(producer.isConfigurationFromContext(configuration, context))

        val runManager = RunManager.getInstance(project)
        runManager.addConfiguration(requireNotNull(produced).configurationSettings)
        try {
            val reused = producer.findOrCreateConfigurationFromContext(context)

            assertSame(produced.configurationSettings, reused?.configurationSettings)
            assertEquals(
                1,
                runManager
                    .getConfigurationSettingsList(FerretRunConfigurationType.getInstance())
                    .count { it.configuration is FerretRunConfiguration },
            )
        } finally {
            runManager.removeConfiguration(produced.configurationSettings)
        }
    }

    fun testMatchingUsesTheResolvedSourcePath() {
        val file = createLocalFile("nested/query.fql")
        val context = contextFor(file)
        val producer = FerretRunConfigurationProducer()
        val configuration = createConfiguration().apply {
            sourcePath = Path.of(requireNotNull(project.basePath))
                .relativize(file.toNioPath())
                .toString()
        }

        assertTrue(producer.isConfigurationFromContext(configuration, context))

        configuration.sourcePath = createLocalFile("other.fql").toNioPath().toString()
        assertFalse(producer.isConfigurationFromContext(configuration, context))
    }

    fun testUnrelatedAndNonLocalFilesDoNotProduceConfigurations() {
        val producer = FerretRunConfigurationProducer()
        val unrelated = createLocalFile("README.md")
        val nonLocal = LightVirtualFile("scratch.fql", FerretLanguageFileType, "RETURN 1")

        assertNull(producer.createConfigurationFromContext(contextFor(unrelated)))
        assertNull(producer.createConfigurationFromContext(ConfigurationContext(nonLocalPsiFile(nonLocal))))
    }

    private fun createConfiguration(): FerretRunConfiguration =
        FerretRunConfigurationType
            .getInstance()
            .configurationFactories
            .single()
            .createTemplateConfiguration(project) as FerretRunConfiguration

    private fun contextFor(file: VirtualFile): ConfigurationContext =
        ConfigurationContext(requireNotNull(PsiManager.getInstance(project).findFile(file)))

    private fun nonLocalPsiFile(file: LightVirtualFile) =
        requireNotNull(PsiManager.getInstance(project).findFile(file))

    private fun createLocalFile(relativePath: String): VirtualFile {
        val path = temporaryRoot.resolve(relativePath)
        Files.createDirectories(path.parent)
        Files.writeString(path, "RETURN 1")
        return requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
    }
}
