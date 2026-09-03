package org.ferretlang.jetbrains.run

import java.util.Collections

/** Transport-independent named values bound to FQL parameters. */
class FerretParameterBindings private constructor(
    entries: Map<String, FerretParameterValue>,
) {
    val entries: Map<String, FerretParameterValue> =
        Collections.unmodifiableMap(LinkedHashMap(entries))

    override fun equals(other: Any?): Boolean =
        this === other || other is FerretParameterBindings && entries == other.entries

    override fun hashCode(): Int = entries.hashCode()

    override fun toString(): String = entries.toString()

    companion object {
        val EMPTY = FerretParameterBindings(emptyMap())

        fun of(entries: Map<String, FerretParameterValue>): FerretParameterBindings =
            if (entries.isEmpty()) EMPTY else FerretParameterBindings(entries)
    }
}

sealed interface FerretParameterValue {
    data object NullValue : FerretParameterValue

    data class BooleanValue(
        val value: Boolean,
    ) : FerretParameterValue

    data class NumberValue(
        val value: Double,
    ) : FerretParameterValue {
        init {
            require(value.isFinite()) {
                "Parameters must contain only finite JSON numbers."
            }
        }
    }

    data class StringValue(
        val value: String,
    ) : FerretParameterValue

    class ArrayValue(
        values: List<FerretParameterValue>,
    ) : FerretParameterValue {
        val values: List<FerretParameterValue> =
            Collections.unmodifiableList(ArrayList(values))

        override fun equals(other: Any?): Boolean =
            this === other || other is ArrayValue && values == other.values

        override fun hashCode(): Int = values.hashCode()

        override fun toString(): String = values.toString()
    }

    class ObjectValue(
        entries: Map<String, FerretParameterValue>,
    ) : FerretParameterValue {
        val entries: Map<String, FerretParameterValue> =
            Collections.unmodifiableMap(LinkedHashMap(entries))

        override fun equals(other: Any?): Boolean =
            this === other || other is ObjectValue && entries == other.entries

        override fun hashCode(): Int = entries.hashCode()

        override fun toString(): String = entries.toString()
    }
}
