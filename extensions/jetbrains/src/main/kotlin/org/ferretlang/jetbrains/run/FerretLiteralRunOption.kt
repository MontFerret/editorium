package org.ferretlang.jetbrains.run

import com.intellij.openapi.util.InvalidDataException
import com.intellij.openapi.util.JDOMExternalizerUtil
import org.jdom.Element
import java.nio.charset.CharacterCodingException
import java.util.Base64

/** IntelliJ expands path macros in Run configuration XML before handing it to the plugin. */
internal object FerretLiteralRunOption {
    private const val ENCODING_ATTRIBUTE = "ferretEncoding"
    private const val ENCODING = "base64url-utf8-v1"
    private val plainSegment = Regex("[A-Za-z0-9_-][A-Za-z0-9._-]*")
    private val encoder = Base64.getUrlEncoder().withoutPadding()

    fun write(element: Element, name: String, value: String) {
        val existing = JDOMExternalizerUtil.readOption(element, name)
        if (value.isEmpty()) {
            existing?.detach()
            return
        }
        val option = existing ?: JDOMExternalizerUtil.writeOption(element, name)
        if (value.split('/').all(plainSegment::matches)) {
            option.removeAttribute(ENCODING_ATTRIBUTE)
            option.setAttribute("value", value)
        } else {
            option.setAttribute(ENCODING_ATTRIBUTE, ENCODING)
            option.setAttribute("value", encoder.encodeToString(value.encodeToByteArray(throwOnInvalidSequence = true)))
        }
    }

    fun readEncoded(element: Element, name: String): String? {
        val option = JDOMExternalizerUtil.readOption(element, name) ?: return null
        val encoding = option.getAttributeValue(ENCODING_ATTRIBUTE) ?: return null
        if (encoding != ENCODING) throw InvalidDataException("Unsupported encoding for Ferret Run option '$name': $encoding")
        val payload = option.getAttributeValue("value") ?: throw InvalidDataException("Missing encoded value for Ferret Run option '$name'.")
        val bytes = try {
            Base64.getUrlDecoder().decode(payload)
        } catch (error: IllegalArgumentException) {
            throw InvalidDataException("Invalid Base64URL value for Ferret Run option '$name'.", error)
        }
        if (encoder.encodeToString(bytes) != payload) {
            throw InvalidDataException("Expected unpadded canonical Base64URL for Ferret Run option '$name'.")
        }
        return try {
            bytes.decodeToString(throwOnInvalidSequence = true)
        } catch (error: CharacterCodingException) {
            throw InvalidDataException("Invalid UTF-8 for Ferret Run option '$name'.", error)
        }
    }
}
