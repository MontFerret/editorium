package org.ferretlang.jetbrains.runtime

import com.intellij.execution.ExecutionException
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.asContextElement
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.UIManager

internal class FerretCatalogControls(
    private val connection: FerretdDaemonConnection,
    private val showReload: Boolean,
    private val onChange: (FerretCatalogState) -> Unit,
) : Disposable {
    private val subscription: Job
    private val status = JTextArea().apply {
        isEditable = false
        isOpaque = false
        lineWrap = true
        wrapStyleWord = true
        font = UIManager.getFont("Label.font")
    }
    private val retry = JButton("Retry discovery")
    private val reload = JButton("Reload runtimes")
    val panel = JPanel(BorderLayout()).apply {
        add(status, BorderLayout.CENTER)
        add(JPanel(FlowLayout(FlowLayout.LEADING, 0, 0)).apply {
            add(retry)
            add(reload)
        }, BorderLayout.SOUTH)
    }

    init {
        retry.addActionListener {
            if (connection.catalogState.value.status == CatalogStatus.UNLOADED) request() else connection.retryDiscovery()
        }
        reload.addActionListener {
            try {
                connection.reloadRuntimes()
            } catch (error: ExecutionException) {
                status.text = error.message
                status.isVisible = true
            }
        }
        render(connection.catalogState.value)
        subscription = connection.observeCatalog(Dispatchers.EDT + ModalityState.any().asContextElement(), ::render)
    }

    fun request() {
        connection.ensureCatalog()
        render(connection.catalogState.value)
    }

    private fun render(value: FerretCatalogState) {
        if (connection.catalogState.value !== value) return
        status.text = when (value.status) {
            CatalogStatus.LOADING -> "Loading runtimes…"
            CatalogStatus.RELOADING -> "Loading runtimes for the saved configuration…"
            CatalogStatus.RELOAD_REQUIRED -> value.error ?: if (value.busy) {
                "Runtime configuration saved. Finish or stop Ferret sessions, then reload runtimes."
            } else "Reload runtimes to use the saved runtime configuration."
            CatalogStatus.DISCOVERY_FAILED -> "Runtime discovery failed. ${value.error.orEmpty()}"
            CatalogStatus.UNLOADED -> value.error.orEmpty()
            CatalogStatus.READY -> ""
        }.ifEmpty {
            if (showReload && value.busy) "Finish or stop Ferret sessions before reloading runtimes." else ""
        }
        status.isVisible = status.text.isNotEmpty()
        retry.isVisible = value.status == CatalogStatus.DISCOVERY_FAILED || (value.status == CatalogStatus.UNLOADED && value.error != null)
        reload.isVisible = showReload || value.status == CatalogStatus.RELOAD_REQUIRED
        reload.isEnabled = !value.busy && value.status != CatalogStatus.RELOADING
        onChange(value)
    }

    override fun dispose() = subscription.cancel()
}
