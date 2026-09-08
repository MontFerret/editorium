package org.ferretlang.jetbrains.execution

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

internal object FerretExecutionOutputFormatter {
    private val gson = GsonBuilder().disableHtmlEscaping().setPrettyPrinting().create()

    fun format(output: FerretdExecutionOutput): String {
        val contentType = output.contentType.substringBefore(';').trim().lowercase()
        if (contentType != "application/json") {
            throw FerretExecutionOutputException("Unsupported Ferret result content type: ${output.contentType}")
        }
        val source = try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(output.data))
                .toString()
        } catch (error: Exception) {
            throw FerretExecutionOutputException("The Ferret result is not valid UTF-8.", error)
        }
        val value = try {
            JsonReader(StringReader(source)).use { reader ->
                reader.strictness = Strictness.STRICT
                if (reader.peek() == JsonToken.END_DOCUMENT) {
                    throw FerretExecutionOutputException("The Ferret result is empty.")
                }
                val parsed = JsonParser.parseReader(reader)
                if (reader.peek() != JsonToken.END_DOCUMENT) {
                    throw FerretExecutionOutputException("The Ferret result contains more than one JSON value.")
                }
                parsed
            }
        } catch (error: FerretExecutionOutputException) {
            throw error
        } catch (error: Exception) {
            throw FerretExecutionOutputException("The Ferret result is not valid JSON.", error)
        }
        return gson.toJson(value)
    }
}

internal class FerretExecutionOutputException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
