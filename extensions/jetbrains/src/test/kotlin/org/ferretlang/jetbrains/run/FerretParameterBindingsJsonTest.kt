package org.ferretlang.jetbrains.run

import junit.framework.TestCase

class FerretParameterBindingsJsonTest : TestCase() {
    fun testBlankInputProducesEmptyBindings() {
        assertSame(FerretParameterBindings.EMPTY, FerretParameterBindingsJson.parse("  \n\t"))
    }

    fun testParsesEverySupportedSemanticValue() {
        val bindings = FerretParameterBindingsJson.parse(
            """{"nothing":null,"enabled":true,"limit":10,"name":"Ada","items":[false,1.5],"nested":{"key":"value"}}""",
        )

        assertEquals(FerretParameterValue.NullValue, bindings.entries["nothing"])
        assertEquals(FerretParameterValue.BooleanValue(true), bindings.entries["enabled"])
        assertEquals(FerretParameterValue.NumberValue(10.0), bindings.entries["limit"])
        assertEquals(FerretParameterValue.StringValue("Ada"), bindings.entries["name"])
        assertEquals(
            FerretParameterValue.ArrayValue(
                listOf(
                    FerretParameterValue.BooleanValue(false),
                    FerretParameterValue.NumberValue(1.5),
                ),
            ),
            bindings.entries["items"],
        )
        assertEquals(
            FerretParameterValue.ObjectValue(
                mapOf("key" to FerretParameterValue.StringValue("value")),
            ),
            bindings.entries["nested"],
        )
    }

    fun testRenderIsDeterministicAndRoundTripsSemanticBindings() {
        val bindings = FerretParameterBindings.of(
            linkedMapOf(
                "zeta" to FerretParameterValue.NumberValue(2.0),
                "alpha" to FerretParameterValue.ObjectValue(
                    linkedMapOf(
                        "second" to FerretParameterValue.BooleanValue(true),
                        "first" to FerretParameterValue.StringValue("one"),
                    ),
                ),
            ),
        )

        val rendered = FerretParameterBindingsJson.render(bindings)

        assertEquals(bindings, FerretParameterBindingsJson.parse(rendered))
        assertTrue(rendered.indexOf("\"alpha\"") < rendered.indexOf("\"zeta\""))
        assertTrue(rendered.indexOf("\"first\"") < rendered.indexOf("\"second\""))
    }

    fun testBindingsDefensivelyCopyAndExposeUnmodifiableEntries() {
        val original = linkedMapOf<String, FerretParameterValue>(
            "name" to FerretParameterValue.StringValue("Ada"),
        )
        val bindings = FerretParameterBindings.of(original)

        original["changed"] = FerretParameterValue.BooleanValue(true)

        assertFalse(bindings.entries.containsKey("changed"))
        try {
            @Suppress("UNCHECKED_CAST")
            (bindings.entries as MutableMap<String, FerretParameterValue>)["changed"] =
                FerretParameterValue.BooleanValue(true)
            fail("Expected the bindings map to reject mutation")
        } catch (_: UnsupportedOperationException) {
            // Expected.
        }
    }

    fun testRejectsMalformedAndNonObjectJson() {
        for (input in listOf("{", "[]", "null", "true", "\"value\"")) {
            val error = parseError(input)

            assertTrue(error.message.orEmpty().contains("Parameters must"))
        }
    }

    fun testRejectsNonFiniteNumbersAtBothModelAndJsonBoundaries() {
        val parsedError = parseError("""{"value":1e400}""")
        val modelError = try {
            FerretParameterValue.NumberValue(Double.NaN)
            fail("Expected a non-finite model value to be rejected")
            error("unreachable")
        } catch (error: IllegalArgumentException) {
            error
        }

        assertEquals("Parameters must contain only finite JSON numbers.", parsedError.message)
        assertEquals("Parameters must contain only finite JSON numbers.", modelError.message)
    }

    private fun parseError(input: String): IllegalArgumentException = try {
        FerretParameterBindingsJson.parse(input)
        fail("Expected invalid JSON parameters to be rejected")
        error("unreachable")
    } catch (error: IllegalArgumentException) {
        error
    }
}
