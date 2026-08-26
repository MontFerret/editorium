package org.ferretlang.jetbrains.lang

import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

object FerretLanguageFileType : LanguageFileType(FerretLanguage) {
    override fun getName(): String = "Ferret"

    override fun getDescription(): String = "Ferret Query Language"

    override fun getDefaultExtension(): String = "fql"

    override fun getIcon(): Icon = FerretIcons.FILE
}
