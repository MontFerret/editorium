package org.ferretlang.jetbrains.execution

import com.google.protobuf.NullValue
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.ferretlang.jetbrains.run.FerretParameterValue
import org.junit.Assert.assertEquals
import org.junit.Test

class FerretStructMapperTest {
    @Test
    fun preservesEveryJsonValueKindRecursively() {
        val mapped = FerretStructMapper.map(
            FerretParameterBindings.of(
                linkedMapOf(
                    "null" to FerretParameterValue.NullValue,
                    "bool" to FerretParameterValue.BooleanValue(true),
                    "number" to FerretParameterValue.NumberValue(1.5),
                    "string" to FerretParameterValue.StringValue("1"),
                    "array" to FerretParameterValue.ArrayValue(
                        listOf(FerretParameterValue.BooleanValue(false), FerretParameterValue.NullValue),
                    ),
                    "object" to FerretParameterValue.ObjectValue(
                        mapOf("nested" to FerretParameterValue.NumberValue(2.0)),
                    ),
                ),
            ),
        )
        assertEquals(NullValue.NULL_VALUE, mapped.fieldsMap.getValue("null").nullValue)
        assertEquals(true, mapped.fieldsMap.getValue("bool").boolValue)
        assertEquals(1.5, mapped.fieldsMap.getValue("number").numberValue, 0.0)
        assertEquals("1", mapped.fieldsMap.getValue("string").stringValue)
        assertEquals(false, mapped.fieldsMap.getValue("array").listValue.valuesList[0].boolValue)
        assertEquals(2.0, mapped.fieldsMap.getValue("object").structValue.fieldsMap.getValue("nested").numberValue, 0.0)
    }
}
