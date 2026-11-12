package org.ferretlang.jetbrains.runtime

import io.grpc.Status
import org.ferretlang.jetbrains.daemon.GrpcFerretdMapper
import org.ferretlang.jetbrains.execution.FerretdRpcException
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ListRuntimesResponse
import org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.RuntimeDescriptor
import org.junit.Assert.*
import org.junit.Test

class FerretRuntimeCatalogTest {
    private val entry = RuntimeDescriptor.newBuilder().setName("App").setLabel("Shared label").setProvider("future").build()

    @Test
    fun preservesOrderCaseLabelsAndUnknownProviders() {
        val response = ListRuntimesResponse.newBuilder().setDefaultRuntime("app")
            .addRuntimes(entry).addRuntimes(entry.toBuilder().setName("app")).build()
        val result = GrpcFerretdMapper.runtimeCatalog(response)
        assertEquals("app", result.defaultRuntime)
        assertEquals(listOf("App", "app"), result.runtimes.map { it.name })
        assertTrue(result.runtimes.all { it.label == "Shared label" && it.provider == "future" })
    }

    @Test
    fun acceptsXmlMetacharactersAndUnicodeButRejectsAnUnpersistableName() {
        val valid = "应用 🦦 <&\""
        val response = ListRuntimesResponse.newBuilder().setDefaultRuntime(valid).addRuntimes(entry.toBuilder().setName(valid))
        assertEquals(valid, GrpcFerretdMapper.runtimeCatalog(response.build()).runtimes.single().name)
        response.addRuntimes(entry.toBuilder().setName("App\u0001Name"))
        val error = assertThrows(FerretdRpcException::class.java) { GrpcFerretdMapper.runtimeCatalog(response.build()) }
        assertTrue(error.message.orEmpty().contains("project XML"))
    }

    @Test
    fun rejectsMalformedCatalogsAndReportsUnsupportedDiscovery() {
        val single = ListRuntimesResponse.newBuilder().setDefaultRuntime("App").addRuntimes(entry)
        val malformed = listOf(
            single.clone().clearRuntimes(), single.clone().clearDefaultRuntime(), single.clone().setDefaultRuntime("app"),
            single.clone().addRuntimes(entry), single.clone().addRuntimes(entry.toBuilder().setName(" App")),
            single.clone().addRuntimes(entry.toBuilder().setName(" ")), single.clone().addRuntimes(entry.toBuilder().clearName()),
            single.clone().setRuntimes(0, entry.toBuilder().clearLabel()), single.clone().setRuntimes(0, entry.toBuilder().clearProvider()),
        )
        malformed.forEach { assertThrows(FerretdRpcException::class.java) { GrpcFerretdMapper.runtimeCatalog(it.build()) } }
        val cause = Status.UNIMPLEMENTED.asRuntimeException()
        val error = GrpcFerretdMapper.error("list-runtimes", cause)
        assertTrue(error.message.orEmpty().contains("does not support runtime discovery"))
        assertSame(cause, error.cause)
    }
}
