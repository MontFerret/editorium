package org.ferretlang.jetbrains.execution

import com.google.protobuf.ListValue
import com.google.protobuf.NullValue
import com.google.protobuf.Struct
import com.google.protobuf.Value
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.ferretlang.jetbrains.run.FerretParameterValue

internal object FerretStructMapper {
    fun map(bindings: FerretParameterBindings): Struct = struct(bindings.entries)

    private fun struct(entries: Map<String, FerretParameterValue>): Struct = Struct.newBuilder().apply {
        entries.toSortedMap().forEach { (name, value) -> putFields(name, value(value)) }
    }.build()

    private fun value(value: FerretParameterValue): Value = Value.newBuilder().apply {
        when (value) {
            FerretParameterValue.NullValue -> nullValue = NullValue.NULL_VALUE
            is FerretParameterValue.BooleanValue -> boolValue = value.value
            is FerretParameterValue.NumberValue -> numberValue = value.value
            is FerretParameterValue.StringValue -> stringValue = value.value
            is FerretParameterValue.ArrayValue -> listValue = ListValue.newBuilder().apply {
                value.values.forEach { addValues(value(it)) }
            }.build()
            is FerretParameterValue.ObjectValue -> structValue = struct(value.entries)
        }
    }.build()
}
