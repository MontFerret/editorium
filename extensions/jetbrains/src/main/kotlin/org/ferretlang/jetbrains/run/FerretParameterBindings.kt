package org.ferretlang.jetbrains.run

import com.google.gson.JsonElement
import com.google.gson.JsonParser
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader

object FerretParameterBindings {
    fun normalize(parameters: String): String = if (parameters.isBlank()) "{}" else parameters

    fun validate(parameters: String) {
        val normalized = normalize(parameters)
        val parsed = try {
            JsonReader(StringReader(normalized)).use { reader ->
                reader.strictness = Strictness.STRICT
                val value = JsonParser.parseReader(reader)
                if (reader.peek() != JsonToken.END_DOCUMENT) {
                    throw IllegalArgumentException("Parameters must contain exactly one JSON value.")
                }
                value
            }
        } catch (error: IllegalArgumentException) {
            throw error
        } catch (error: Exception) {
            throw IllegalArgumentException("Parameters must be valid JSON: ${error.message}", error)
        }

        if (!parsed.isJsonObject) {
            throw IllegalArgumentException("Parameters must be a JSON object.")
        }

        validateFiniteNumbers(parsed)
    }

    private fun validateFiniteNumbers(value: JsonElement) {
        when {
            value.isJsonArray -> value.asJsonArray.forEach(::validateFiniteNumbers)
            value.isJsonObject -> value.asJsonObject.entrySet().forEach { validateFiniteNumbers(it.value) }
            value.isJsonPrimitive && value.asJsonPrimitive.isNumber -> {
                if (!value.asJsonPrimitive.asDouble.isFinite()) {
                    throw IllegalArgumentException("Parameters must contain only finite JSON numbers.")
                }
            }
        }
    }
}
