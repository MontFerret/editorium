package org.ferretlang.jetbrains.daemon

import com.google.gson.JsonParser
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader

internal data class FerretdReadyEvent(
    val endpoint: String,
    val port: Int,
    val version: String,
) {
    companion object {
        private val endpointPattern = Regex("^tcp://127\\.0\\.0\\.1:([1-9][0-9]{0,4})$")

        fun parse(line: String, expectedVersion: String): FerretdReadyEvent? {
            val value = try {
                JsonReader(StringReader(line)).use { reader ->
                    reader.strictness = Strictness.STRICT
                    val parsed = JsonParser.parseReader(reader)
                    if (reader.peek() != JsonToken.END_DOCUMENT) {
                        return null
                    }
                    parsed
                }
            } catch (_: Exception) {
                return null
            }
            if (!value.isJsonObject) {
                return null
            }
            val objectValue = value.asJsonObject
            val event = objectValue.get("event")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
            if (event != "ferretd.ready") {
                return null
            }
            val endpoint = requiredString(objectValue, "endpoint")
            val version = requiredString(objectValue, "version")
            val message = requiredString(objectValue, "message")
            if (version != expectedVersion) {
                throw FerretdConnectionException(
                    "The bundled Ferret daemon reported version $version; expected $expectedVersion.",
                )
            }
            if (message != "ferretd started") {
                throw FerretdConnectionException("The Ferret daemon returned an invalid readiness message.")
            }
            val match = endpointPattern.matchEntire(endpoint)
                ?: throw FerretdConnectionException("The Ferret daemon reported a non-loopback endpoint: $endpoint")
            val port = match.groupValues[1].toIntOrNull()
                ?.takeIf { it in 1..65535 }
                ?: throw FerretdConnectionException("The Ferret daemon reported an invalid TCP port: $endpoint")
            return FerretdReadyEvent(endpoint, port, version)
        }

        private fun requiredString(value: com.google.gson.JsonObject, name: String): String {
            val element = value.get(name)
            if (element == null || !element.isJsonPrimitive || !element.asJsonPrimitive.isString) {
                throw FerretdConnectionException("The Ferret daemon readiness event is missing $name.")
            }
            return element.asString
        }
    }
}

internal class FerretdConnectionException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
