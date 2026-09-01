package org.ferretlang.jetbrains.daemon

import com.intellij.openapi.application.PathManager
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

internal class FerretdBinary(
    private val pluginRoot: Path,
    private val platform: FerretdPlatform = FerretdPlatform.current(),
) {
    fun resolve(): Path {
        val path = pluginRoot
            .resolve("ferretd")
            .resolve(platform.platformDirectory)
            .resolve(platform.architectureDirectory)
            .resolve(platform.executableName)
            .normalize()
        try {
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                throw FerretdBinaryException(
                    "The bundled ferretd executable is missing for " +
                        "${platform.platformDirectory}-${platform.architectureDirectory}: $path.",
                )
            }
            if (platform.unix && !Files.isExecutable(path)) {
                throw FerretdBinaryException(
                    "The bundled ferretd executable is not executable for " +
                        "${platform.platformDirectory}-${platform.architectureDirectory}: $path.",
                )
            }
        } catch (error: SecurityException) {
            throw FerretdBinaryException("Cannot access the bundled ferretd executable: $path.", error)
        }
        return path
    }

    companion object {
        fun installed(): FerretdBinary {
            val pluginJar = PathManager.getJarForClass(FerretdBinary::class.java)
                ?: throw FerretdBinaryException("Cannot locate the installed Ferret plugin directory.")
            val libraryDirectory = pluginJar.parent
            val pluginRoot = libraryDirectory
                ?.takeIf { it.fileName?.toString() == "lib" }
                ?.parent
                ?: throw FerretdBinaryException(
                    "The Ferret plugin class is not installed beneath a plugin lib directory: $pluginJar.",
                )
            return FerretdBinary(pluginRoot)
        }
    }
}
