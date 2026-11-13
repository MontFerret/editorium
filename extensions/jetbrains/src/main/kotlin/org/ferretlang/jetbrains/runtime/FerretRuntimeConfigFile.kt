package org.ferretlang.jetbrains.runtime

import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path

internal object FerretRuntimeConfigFile {
    fun resolve(value: String, projectBase: String?): Path? {
        if (value.isEmpty()) return null
        val path = try {
            val entered = Path.of(value)
            val absolute = if (entered.isAbsolute) entered else {
                requireNotNull(projectBase) {
                    "The runtime configuration file must be absolute because the project has no base directory."
                }
                Path.of(projectBase).resolve(entered)
            }
            require(absolute.isAbsolute) { "The runtime configuration file must resolve to an absolute path: $value" }
            // ferretd cleans the absolute path lexically before opening it.
            absolute.normalize()
        } catch (error: InvalidPathException) {
            throw IllegalArgumentException("Invalid runtime configuration file path: $value", error)
        }
        require(!Files.notExists(path)) { "Runtime configuration file does not exist: $path" }
        require(Files.isReadable(path)) { "Runtime configuration file is unreadable: $path" }
        require(Files.isRegularFile(path)) { "Runtime configuration path is not a regular file: $path" }
        return path
    }
}
