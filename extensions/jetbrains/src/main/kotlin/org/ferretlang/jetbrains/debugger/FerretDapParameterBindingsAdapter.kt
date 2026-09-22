package org.ferretlang.jetbrains.debugger

import com.google.gson.TypeAdapter
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonWriter
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.ferretlang.jetbrains.run.FerretParameterValue

/** Preserve null bindings without serializing absent optional fields in ordinary DAP messages. */
internal class FerretDapParameterBindingsAdapter : TypeAdapter<FerretParameterBindings>() {
    override fun write(writer: JsonWriter, bindings: FerretParameterBindings) {
        val previous = writer.serializeNulls
        writer.serializeNulls = true
        try { writeObject(writer, bindings.entries) } finally { writer.serializeNulls = previous }
    }

    override fun read(reader: JsonReader): FerretParameterBindings = error("DAP launch parameters are outbound only.")

    private fun writeObject(writer: JsonWriter, entries: Map<String, FerretParameterValue>) {
        writer.beginObject()
        entries.forEach { (name, value) -> writer.name(name); writeValue(writer, value) }
        writer.endObject()
    }

    private fun writeValue(writer: JsonWriter, value: FerretParameterValue) {
        when (value) {
            FerretParameterValue.NullValue -> writer.nullValue()
            is FerretParameterValue.BooleanValue -> writer.value(value.value)
            is FerretParameterValue.NumberValue -> writer.value(value.value)
            is FerretParameterValue.StringValue -> writer.value(value.value)
            is FerretParameterValue.ArrayValue -> {
                writer.beginArray()
                value.values.forEach { writeValue(writer, it) }
                writer.endArray()
            }
            is FerretParameterValue.ObjectValue -> writeObject(writer, value.entries)
        }
    }
}
