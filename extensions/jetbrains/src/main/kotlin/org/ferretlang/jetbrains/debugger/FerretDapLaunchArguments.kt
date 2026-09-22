package org.ferretlang.jetbrains.debugger

import org.ferretlang.jetbrains.launch.FerretResolvedLaunchInput

internal object FerretDapLaunchArguments {
    fun from(input: FerretResolvedLaunchInput): Map<String, Any> = linkedMapOf<String, Any>().apply {
        put("program", input.source.toString())
        put("cwd", input.workspaceRoot.toString())
        put("parameters", input.bindings)
        put("stopOnEntry", false)
        input.workingDirectory?.let { put("workingDirectory", it.toString()) }
    }
}
