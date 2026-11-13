package org.ferretlang.jetbrains.debugger

import com.google.gson.JsonElement
import com.google.gson.annotations.SerializedName
import org.eclipse.lsp4j.debug.Capabilities

internal class FerretDapCapabilities : Capabilities() {
    @SerializedName("supportsFerretRuntimeSelection")
    private var selection: JsonElement? = null

    fun supportsRuntimeSelection(): Boolean {
        val field = selection ?: return false
        check(field.isJsonPrimitive && field.asJsonPrimitive.isBoolean) {
            "The Ferret adapter returned an invalid runtime selection capability."
        }
        return field.asBoolean
    }
}
