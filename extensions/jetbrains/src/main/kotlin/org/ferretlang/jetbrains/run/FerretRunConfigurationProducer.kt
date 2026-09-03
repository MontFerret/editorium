package org.ferretlang.jetbrains.run

import com.intellij.execution.actions.ConfigurationContext
import com.intellij.execution.actions.LazyRunConfigurationProducer
import com.intellij.execution.configurations.ConfigurationFactory
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.util.Ref
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile

class FerretRunConfigurationProducer : LazyRunConfigurationProducer<FerretRunConfiguration>(), DumbAware {
    override fun getConfigurationFactory(): ConfigurationFactory =
        FerretRunConfigurationType.getInstance().configurationFactories.single()

    override fun setupConfigurationFromContext(
        configuration: FerretRunConfiguration,
        context: ConfigurationContext,
        sourceElement: Ref<PsiElement>,
    ): Boolean {
        val (psiFile, virtualFile) = contextFile(context) ?: return false

        configuration.sourcePath = virtualFile.toNioPath().toAbsolutePath().normalize().toString()
        configuration.workingDirectory = context.project.basePath.orEmpty()
        configuration.setGeneratedName()
        sourceElement.set(psiFile)

        return true
    }

    override fun isConfigurationFromContext(
        configuration: FerretRunConfiguration,
        context: ConfigurationContext,
    ): Boolean {
        val (_, virtualFile) = contextFile(context) ?: return false

        return configuration.resolvedSourcePathOrNull() ==
            virtualFile.toNioPath().toAbsolutePath().normalize()
    }

    private fun contextFile(context: ConfigurationContext): Pair<PsiFile, VirtualFile>? {
        val psiFile = context.psiLocation?.containingFile ?: return null
        val virtualFile = psiFile.virtualFile ?: return null
        if (!FerretRunSourceFile.isEligible(virtualFile)) {
            return null
        }

        return psiFile to virtualFile
    }
}
