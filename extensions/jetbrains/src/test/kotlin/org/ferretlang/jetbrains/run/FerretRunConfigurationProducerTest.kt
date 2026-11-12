package org.ferretlang.jetbrains.run

import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.replaceService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.ferretlang.jetbrains.daemon.FakeDaemonProcess
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.daemon.FerretdDaemonLauncher
import org.ferretlang.jetbrains.daemon.FerretdInstallation
import org.ferretlang.jetbrains.debugger.FerretDapSession
import org.ferretlang.jetbrains.debugger.FerretDebugLauncher
import org.ferretlang.jetbrains.execution.FakeFerretdRpc
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
import java.util.concurrent.atomic.AtomicInteger

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
        assertSame(FerretParameterBindings.EMPTY, configuration.parameters)
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

    fun testContextLaunchesRejectConfiguredFilesAndEveryExplicitRuntime() {
        val root = Files.createDirectories(Path.of(requireNotNull(project.basePath)))
        val source = Files.createTempFile(root, "runtime-", ".fql")
        val file = createLocalFile(source.toString())
        val configurationFile = Files.writeString(temporaryRoot.resolve("runtimes.json"), "{}")
        val config = requireNotNull(FerretRunConfigurationProducer().createConfigurationFromContext(contextFor(file)))
            .configuration as FerretRunConfiguration
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val version = "1.0.0"
        val process = FakeDaemonProcess.ready(version)
        val rpc = FakeFerretdRpc(version, root, emptyList(), process::destroy)
        val connection = FerretdDaemonConnection.testing(scope, FerretdDaemonLauncher.testing(
            scope, { FerretdInstallation(Path.of("ferretd"), version) }, { _, _, _ -> process }, { _, _ -> rpc },
        ))
        project.replaceService(FerretdDaemonConnection::class.java, connection, testRootDisposable)
        val dapStarts = AtomicInteger()
        project.replaceService(FerretDebugLauncher::class.java, FerretDebugLauncher.testing(scope) { input, listener ->
            FerretDapSession(input, listener, { Path.of("ferretd") }, {
                dapStarts.incrementAndGet()
                error("Restricted launch started a DAP process")
            })
        }, testRootDisposable)
        val executors = listOf(DefaultRunExecutor.getRunExecutorInstance(), DefaultDebugExecutor.getDebugExecutorInstance())
        try {
            for ((path, name) in listOf("" to "local", "" to "App", configurationFile.toString() to "")) {
                config.runtimeName = name
                connection.applyConfigPath(path)
                for (executor in executors) {
                    val failure = java.util.concurrent.atomic.AtomicReference<Throwable>()
                    val environment = ExecutionEnvironmentBuilder.create(executor, config).build(object : ProgramRunner.Callback {
                        override fun processStarted(descriptor: RunContentDescriptor) { fail("Restricted launch started") }
                        override fun processNotStarted(error: Throwable?) {
                            failure.set(error ?: AssertionError("Missing launch error"))
                        }
                    })
                    val reported = com.intellij.testFramework.LoggedErrorProcessor.executeAndReturnLoggedError {
                        environment.runner.execute(environment)
                        PlatformTestUtil.waitWithEventsDispatching("Expected a rejected launch", { failure.get() != null }, 10)
                    }
                    assertTrue(reported.toString(), reported.message.orEmpty().contains("Daemon default"))
                    assertFalse(connection.catalogState.value.busy)
                    assertEquals(0, rpc.calls.count { it.startsWith("createSession:") })
                    assertEquals(0, dapStarts.get())
                }
            }
        } finally {
            runBlocking { connection.closeForTest() }
            scope.cancel()
            Files.deleteIfExists(source)
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

    fun testNamesUseProjectRelativeIdentityAndContextDoesNotInheritTemplateParameters() {
        val base = Path.of(requireNotNull(project.basePath))
        val first = createLocalFile(base.resolve("first/query.fql").toString())
        val second = createLocalFile(base.resolve("second/query.fql").toString())
        val runManager = RunManager.getInstance(project)
        val factory = FerretRunConfigurationType.getInstance().configurationFactories.single()
        val template = runManager.getConfigurationTemplate(factory).configuration as FerretRunConfiguration
        val original = template.parameters
        template.parametersJson = "{\"inherited\":true}"
        try {
            val producer = FerretRunConfigurationProducer()
            val a = requireNotNull(producer.createConfigurationFromContext(contextFor(first))).configuration as FerretRunConfiguration
            val b = requireNotNull(producer.createConfigurationFromContext(contextFor(second))).configuration as FerretRunConfiguration
            assertEquals("first/query.fql", a.name)
            assertEquals("second/query.fql", b.name)
            assertSame(FerretParameterBindings.EMPTY, a.parameters)
            assertFalse(producer.isConfigurationFromContext(a, contextFor(second)))
        } finally {
            template.parameters = original
        }
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
