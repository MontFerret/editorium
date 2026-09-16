package org.ferretlang.jetbrains.debugger

import org.ferretlang.jetbrains.launch.FerretResolvedLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterValue

internal object FerretDapLaunchArguments {
    fun from(input: FerretResolvedLaunchInput): Map<String, Any> = linkedMapOf<String, Any>().apply {
        put("program", input.source.toString())
        put("cwd", input.workspaceRoot.toString())
        put("parameters", input.bindings.entries.mapValues { value(it.value) })
        put("stopOnEntry", false)
        input.workingDirectory?.let { put("workingDirectory", it.toString()) }
    }

    private fun value(value: FerretParameterValue): Any? = when (value) {
        FerretParameterValue.NullValue -> null
        is FerretParameterValue.BooleanValue -> value.value
        is FerretParameterValue.NumberValue -> value.value
        is FerretParameterValue.StringValue -> value.value
        is FerretParameterValue.ArrayValue -> value.values.map(::value)
        is FerretParameterValue.ObjectValue -> value.entries.mapValues { value(it.value) }
    }
}
