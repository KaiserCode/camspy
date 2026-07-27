package com.camspy.app

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

data class ProxyConfig(
    val address: String,
    val port: Int,
    val type: String = "http", // http, socks5
    val username: String? = null,
    val password: String? = null,
    var status: String = "untested", // untested, ok, dead, testing
    var latencyMs: Long? = null,
    var publicIp: String? = null,
    var active: Boolean = false
)

data class HttpResult(
    val success: Boolean,
    val body: String? = null,
    val statusCode: Int = 0,
    val error: String? = null,
    val proxyUsed: String? = null
)

enum class ProxyMode { LOCKED, AUTO_ROTATE }

class NativeHttpEngine(private val context: Context) {

    private val gson = Gson()
    private val prefs: SharedPreferences = context.getSharedPreferences("camspy_prefs", Context.MODE_PRIVATE)

    var proxyMode: ProxyMode = ProxyMode.LOCKED
    var proxyList: MutableList<ProxyConfig> = mutableListOf()
    var lockedProxy: ProxyConfig? = null
    private val requestCounter = AtomicInteger(0)

    private val userAgents = listOf(
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 14; OnePlus 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 13; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 11; Galaxy S21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36"
    )

    // Build OkHttpClient with optional proxy
    private fun buildClient(proxy: ProxyConfig? = null, timeoutSecs: Long = 10): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(timeoutSecs, TimeUnit.SECONDS)
            .readTimeout(timeoutSecs, TimeUnit.SECONDS)
            .writeTimeout(timeoutSecs, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)

        proxy?.let { p ->
            val proxyType = if (p.type == "socks5") Proxy.Type.SOCKS else Proxy.Type.HTTP
            val javaProxy = Proxy(proxyType, InetSocketAddress(p.address, p.port))
            builder.proxy(javaProxy)

            if (!p.username.isNullOrEmpty()) {
                builder.proxyAuthenticator { _, response ->
                    val credential = Credentials.basic(p.username, p.password ?: "")
                    response.request.newBuilder()
                        .header("Proxy-Authorization", credential)
                        .build()
                }
            }
        }

        return builder.build()
    }

    // Pick which proxy to use for this request
    private fun pickProxy(): ProxyConfig? {
        return when (proxyMode) {
            ProxyMode.LOCKED -> lockedProxy
            ProxyMode.AUTO_ROTATE -> {
                val working = proxyList.filter { it.status == "ok" }
                if (working.isEmpty()) return null
                val idx = requestCounter.getAndIncrement() % working.size
                working[idx]
            }
        }
    }

    // Core fetch function - native HTTP, no CORS
    suspend fun fetch(
        url: String,
        headers: Map<String, String> = emptyMap(),
        useProxy: Boolean = true,
        timeoutSecs: Long = 10,
        rotateUA: Boolean = true
    ): HttpResult = withContext(Dispatchers.IO) {
        val proxy = if (useProxy) pickProxy() else null
        val client = buildClient(proxy, timeoutSecs)

        try {
            val reqBuilder = Request.Builder().url(url)

            if (rotateUA) {
                reqBuilder.header("User-Agent", userAgents.random())
            }
            reqBuilder.header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            reqBuilder.header("Accept-Language", "en-US,en;q=0.9")

            headers.forEach { (k, v) -> reqBuilder.header(k, v) }

            val response = client.newCall(reqBuilder.build()).execute()
            val body = response.body?.string() ?: ""
            response.close()

            HttpResult(
                success = response.isSuccessful || response.code in 200..399,
                body = body,
                statusCode = response.code,
                proxyUsed = proxy?.let { "${it.address}:${it.port}" }
            )
        } catch (e: Exception) {
            HttpResult(success = false, error = e.message, proxyUsed = proxy?.let { "${it.address}:${it.port}" })
        }
    }

    // Get current public IP (uses proxy if set)
    suspend fun getPublicIp(useProxy: Boolean = true): String? = withContext(Dispatchers.IO) {
        val endpoints = listOf(
            "https://api.ipify.org?format=json",
            "https://api.myip.com",
            "https://ifconfig.me/ip"
        )
        for (endpoint in endpoints) {
            try {
                val result = fetch(endpoint, useProxy = useProxy, timeoutSecs = 5)
                if (result.success && result.body != null) {
                    // Try JSON parse first
                    val ipRegex = Regex("""(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})""")
                    val match = ipRegex.find(result.body)
                    if (match != null) return@withContext match.groupValues[1]
                }
            } catch (e: Exception) { continue }
        }
        null
    }

    // Test a single proxy
    suspend fun testProxy(proxy: ProxyConfig): ProxyConfig = withContext(Dispatchers.IO) {
        val start = System.currentTimeMillis()
        try {
            val client = buildClient(proxy, 6)
            val request = Request.Builder()
                .url("https://api.ipify.org?format=json")
                .header("User-Agent", userAgents.random())
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: ""
            response.close()

            if (response.isSuccessful) {
                val ipRegex = Regex("""(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})""")
                val ip = ipRegex.find(body)?.groupValues?.get(1)
                proxy.copy(
                    status = "ok",
                    latencyMs = System.currentTimeMillis() - start,
                    publicIp = ip
                )
            } else {
                proxy.copy(status = "dead", latencyMs = null)
            }
        } catch (e: Exception) {
            proxy.copy(status = "dead", latencyMs = null)
        }
    }

    // Fetch free proxies from public sources
    suspend fun fetchFreeProxies(): List<ProxyConfig> = withContext(Dispatchers.IO) {
        val sources = listOf(
            "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all",
            "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
            "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
            "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt"
        )

        val proxies = mutableSetOf<String>()
        val ipPortRegex = Regex("""\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}""")

        for (src in sources) {
            try {
                val result = fetch(src, useProxy = false, timeoutSecs = 8)
                if (result.success && result.body != null) {
                    ipPortRegex.findAll(result.body).forEach { proxies.add(it.value) }
                }
            } catch (e: Exception) { continue }
        }

        proxies.map { addr ->
            val parts = addr.split(":")
            ProxyConfig(address = parts[0], port = parts[1].toIntOrNull() ?: 8080)
        }
    }

    // Save proxy list to prefs
    fun saveProxies() {
        prefs.edit().putString("proxy_list", gson.toJson(proxyList)).apply()
    }

    // Load proxy list from prefs
    fun loadProxies(): List<ProxyConfig> {
        val json = prefs.getString("proxy_list", null) ?: return emptyList()
        return try {
            gson.fromJson(json, Array<ProxyConfig>::class.java).toList()
        } catch (e: Exception) { emptyList() }
    }
}
