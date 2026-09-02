package org.ferretlang.jetbrains.daemon

import java.util.Locale

internal data class FerretdPlatform(
    val platformDirectory: String,
    val architectureDirectory: String,
    val executableName: String,
    val unix: Boolean,
) {
    companion object {
        fun current(): FerretdPlatform = resolve(
            System.getProperty("os.name", ""),
            System.getProperty("os.arch", ""),
        )

        fun resolve(osName: String, osArchitecture: String): FerretdPlatform {
            val platform = when (osName.trim().lowercase(Locale.ROOT)) {
                "darwin", "mac os x", "macos" -> "darwin"
                "linux" -> "linux"
                else -> if (osName.trim().lowercase(Locale.ROOT).startsWith("windows")) {
                    "win32"
                } else {
                    throw unsupported(osName, osArchitecture)
                }
            }
            val architecture = when (osArchitecture.trim().lowercase(Locale.ROOT)) {
                "aarch64", "arm64" -> "arm64"
                "amd64", "x86_64" -> "x64"
                else -> throw unsupported(osName, osArchitecture)
            }
            return FerretdPlatform(
                platformDirectory = platform,
                architectureDirectory = architecture,
                executableName = if (platform == "win32") "ferretd.exe" else "ferretd",
                unix = platform != "win32",
            )
        }

        private fun unsupported(osName: String, osArchitecture: String): FerretdPlatformException =
            FerretdPlatformException(
                "Unsupported ferretd platform: os.name=\"$osName\", os.arch=\"$osArchitecture\".",
            )
    }
}
