package org.ferretlang.jetbrains.runtime

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import java.io.IOException
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.security.DigestInputStream
import java.security.MessageDigest

internal class FerretRuntimeConfigFingerprint private constructor(val path: Path, private val digest: ByteArray) {
    suspend fun matches(): Boolean = try {
        digest.contentEquals(readDigest(path))
    } catch (_: IOException) {
        false
    } catch (_: SecurityException) {
        false
    }

    companion object {
        suspend fun capture(path: Path): FerretRuntimeConfigFingerprint =
            FerretRuntimeConfigFingerprint(path, readDigest(path))

        private suspend fun readDigest(path: Path): ByteArray = runInterruptible(Dispatchers.IO) {
            if (!Files.isRegularFile(path)) throw IOException("The runtime configuration is not a readable file.")
            val hash = MessageDigest.getInstance("SHA-256")
            DigestInputStream(Files.newInputStream(path), hash).use { it.transferTo(OutputStream.nullOutputStream()) }
            hash.digest()
        }
    }
}
