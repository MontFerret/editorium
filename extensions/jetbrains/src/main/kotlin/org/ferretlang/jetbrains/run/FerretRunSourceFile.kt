package org.ferretlang.jetbrains.run

import com.intellij.openapi.vfs.VirtualFile
import org.ferretlang.jetbrains.lang.FerretLanguageFileType

object FerretRunSourceFile {
    fun isEligible(file: VirtualFile): Boolean =
        file.isInLocalFileSystem &&
            file.fileType === FerretLanguageFileType &&
            file.extension == FerretLanguageFileType.defaultExtension
}
