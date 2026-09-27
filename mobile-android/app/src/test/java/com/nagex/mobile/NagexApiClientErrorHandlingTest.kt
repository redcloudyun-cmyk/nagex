package com.nagex.mobile

import androidx.test.core.app.ApplicationProvider
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * R23.6M Phase B4 — certifies the previously-disclosed gap: when the
 * server reports a device as revoked/rejected (DEVICE_TRANSPORT_REJECTED),
 * the Android client surfaces that truthfully as a typed ApiException
 * rather than crashing uninterpretably or silently treating it as success.
 * Uses a real HTTP server (MockWebServer) rather than mocking OkHttp
 * internals, so this exercises the actual request/response parsing path.
 */
@RunWith(RobolectricTestRunner::class)
class NagexApiClientErrorHandlingTest {

    private lateinit var server: MockWebServer
    private lateinit var config: NagexServerConfig
    private lateinit var client: NagexApiClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        config = NagexServerConfig(context)
        config.serverBaseUrl = server.url("/").toString().trimEnd('/')
        config.tenantId = "ten_a"
        config.principalId = "usr_a"
        client = NagexApiClient(config)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `a revoked-device server response surfaces as a typed ApiException carrying the real error code`() {
        val errorBody = JSONObject().put("code", "DEVICE_TRANSPORT_REJECTED").put("message", "This device message could not be verified.")
        server.enqueue(MockResponse().setResponseCode(403).setBody(errorBody.toString()))

        val ex = assertThrows(NagexApiClient.ApiException::class.java) {
            client.resolveContacts("dev_revoked", "Alex", emptyList())
        }
        assertEquals("DEVICE_TRANSPORT_REJECTED", ex.code)
        assertEquals(403, ex.httpStatus)
    }

    @Test
    fun `a successful resolve response is parsed into a typed result, not left as raw JSON`() {
        val body = JSONObject().put("status", "NOT_FOUND")
        server.enqueue(MockResponse().setResponseCode(200).setBody(body.toString()))

        val result = client.resolveContacts("dev_1", "Nobody", emptyList())
        assertEquals("NOT_FOUND", result.status)
    }
}
