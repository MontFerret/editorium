package org.ferretlang.jetbrains.runtime

internal data class FerretRuntimeCatalog(val defaultRuntime: String, val runtimes: List<FerretRuntimeDescriptor>)

internal data class FerretRuntimeDescriptor(val name: String, val label: String, val provider: String) {
    companion object {
        val LOCAL = FerretRuntimeDescriptor("local", "Built-in Ferret", "native")
    }
}

internal enum class CatalogStatus {
    UNLOADED, LOADING, READY, DISCOVERY_FAILED, RELOAD_REQUIRED, RELOADING,
}

internal data class FerretCatalogState(
    val status: CatalogStatus = CatalogStatus.UNLOADED,
    val catalog: FerretRuntimeCatalog? = null,
    val error: String? = null,
    val busy: Boolean = false,
)
