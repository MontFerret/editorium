package org.ferretlang.jetbrains.runtime

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@Service(Service.Level.PROJECT)
@State(name = "FerretRuntimeSettings", storages = [Storage("ferret.xml")])
internal class FerretRuntimeSettings : SimplePersistentStateComponent<FerretRuntimeSettings.Options>(Options()) {
    // The project connection observes standard IDE state restoration, including external project reloads.
    internal var pathRestored: ((String) -> Unit)? = null

    @Synchronized
    override fun loadState(state: Options) {
        super.loadState(state)
        pathRestored?.invoke(state.runtimeConfigPath.orEmpty())
    }

    class Options : BaseState() {
        var runtimeConfigPath by string("")
    }
}
