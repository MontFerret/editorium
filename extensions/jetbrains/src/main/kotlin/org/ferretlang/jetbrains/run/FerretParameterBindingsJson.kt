package org.ferretlang.jetbrains.run

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader

/** JSON is the editor and persistence boundary, not the execution transport model. */
object FerretParameterBindingsJson {
    private val gson: Gson = GsonBuilder()
        .disableHtmlEscaping()
        .setPrettyPrinting()
        .create()

    fun parse(input: String): FerretParameterBindings {
        val parsed = try {
            JsonReader(StringReader(normalize(input))).use { reader ->
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

        return FerretParameterBindings.of(parseObject(parsed.asJsonObject))
    }

    fun render(bindings: FerretParameterBindings): String =
        gson.toJson(renderObject(bindings.entries))

    fun normalize(input: String): String = if (input.isBlank()) "{}" else input

    private fun parseObject(value: JsonObject): Map<String, FerretParameterValue> =
        LinkedHashMap<String, FerretParameterValue>(value.size()).apply {
            value.entrySet().forEach { (name, item) ->
                put(name, parseValue(item))
            }
        }

    private fun parseValue(value: JsonElement): FerretParameterValue = when {
        value.isJsonNull -> FerretParameterValue.NullValue
        value.isJsonArray -> FerretParameterValue.ArrayValue(value.asJsonArray.map(::parseValue))
        value.isJsonObject -> FerretParameterValue.ObjectValue(parseObject(value.asJsonObject))
        value.asJsonPrimitive.isBoolean -> FerretParameterValue.BooleanValue(value.asBoolean)
        value.asJsonPrimitive.isString -> FerretParameterValue.StringValue(value.asString)
        else -> FerretParameterValue.NumberValue(value.asDouble)
    }

    private fun renderObject(entries: Map<String, FerretParameterValue>): JsonObject =
        JsonObject().apply {
            entries.toSortedMap().forEach { (name, value) ->
                add(name, renderValue(value))
            }
        }

    private fun renderValue(value: FerretParameterValue): JsonElement = when (value) {
        FerretParameterValue.NullValue -> JsonNull.INSTANCE
        is FerretParameterValue.BooleanValue -> JsonPrimitive(value.value)
        is FerretParameterValue.NumberValue -> JsonPrimitive(value.value)
        is FerretParameterValue.StringValue -> JsonPrimitive(value.value)
        is FerretParameterValue.ArrayValue -> JsonArray().apply {
            value.values.forEach { add(renderValue(it)) }
        }
        is FerretParameterValue.ObjectValue -> renderObject(value.entries)
    }
}
