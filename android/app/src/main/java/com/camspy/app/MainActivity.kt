package com.camspy.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.*
import android.view.WindowManager
import android.view.View
import android.graphics.Color
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val defaultClient = buildClient(null)

    // ─── OkHttp Client Builder ────────────────────────────────────────
    private fun buildClient(proxy: ProxyConfig?): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(8, TimeUnit.SECONDS)
            .followRedirects(true)

        if (proxy != null) {
            val proxyType = if (proxy.type == "socks5") Proxy.Type.SOCKS else Proxy.Type.HTTP
            val parts = proxy.address.split(":")
            val host = parts[0]
            val port = parts.getOrNull(1)?.toIntOrNull() ?: 8080
            builder.proxy(Proxy(proxyType, InetSocketAddress(host, port)))
            if (proxy.username != null && proxy.password != null) {
                builder.proxyAuthenticator { _, response ->
                    val credential = Credentials.basic(proxy.username, proxy.password)
                    response.request.newBuilder()
                        .header("Proxy-Authorization", credential)
                        .build()
                }
            }
        }
        return builder.build()
    }

    data class ProxyConfig(
        val address: String,
        val type: String = "http",
        val username: String? = null,
        val password: String? = null
    )

    // ─── Fetch with optional proxy override ───────────────────────────
    private fun fetchUrl(url: String, proxyOverride: ProxyConfig?, headers: Map<String, String> = emptyMap()): Pair<Int, String> {
        return try {
            val client = if (proxyOverride != null) buildClient(proxyOverride) else defaultClient
            val reqBuilder = Request.Builder().url(url)
            headers.forEach { (k, v) -> reqBuilder.addHeader(k, v) }
            // Rotating user agents
            val uas = listOf(
                "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
                "Mozilla/5.0 (Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36"
            )
            reqBuilder.header("User-Agent", uas.random())
            val response = client.newCall(reqBuilder.build()).execute()
            val body = response.body?.string() ?: ""
            Pair(response.code, body)
        } catch (e: Exception) {
            Pair(0, e.message ?: "error")
        }
    }

    // ─── JavaScript Bridge ────────────────────────────────────────────
    inner class CamSpyBridge {

        @JavascriptInterface
        fun fetchHttp(url: String, proxyJson: String?, headersJson: String?): String {
            val proxy = proxyJson?.let { parseProxy(it) }
            val headers = headersJson?.let { parseHeaders(it) } ?: emptyMap()
            val (code, body) = fetchUrl(url, proxy, headers)
            val result = JSONObject()
            result.put("status", code)
            result.put("body", body)
            result.put("ok", code in 200..299)
            return result.toString()
        }

        @JavascriptInterface
        fun testProxy(proxyJson: String): String {
            return try {
                val proxy = parseProxy(proxyJson) ?: return jsonError("Invalid proxy")
                val start = System.currentTimeMillis()
                val (code, body) = fetchUrl("https://api.ipify.org?format=json", proxy)
                val latency = System.currentTimeMillis() - start
                val result = JSONObject()
                if (code == 200) {
                    val ipData = JSONObject(body)
                    result.put("ok", true)
                    result.put("ip", ipData.optString("ip", "unknown"))
                    result.put("latency", latency)
                    result.put("status", "ok")
                } else {
                    result.put("ok", false)
                    result.put("status", "dead")
                    result.put("latency", latency)
                }
                result.toString()
            } catch (e: Exception) {
                jsonError(e.message ?: "proxy test failed")
            }
        }

        @JavascriptInterface
        fun getPublicIp(proxyJson: String?): String {
            return try {
                val proxy = proxyJson?.let { parseProxy(it) }
                val (code, body) = fetchUrl("https://api.ipify.org?format=json", proxy)
                if (code == 200) {
                    val data = JSONObject(body)
                    val result = JSONObject()
                    result.put("ip", data.optString("ip", "unknown"))
                    result.put("ok", true)
                    result.toString()
                } else {
                    jsonError("Could not fetch IP")
                }
            } catch (e: Exception) {
                jsonError(e.message ?: "error")
            }
        }

        @JavascriptInterface
        fun fetchFreeProxies(): String {
            val sources = listOf(
                "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all",
                "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
                "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt"
            )
            val proxies = mutableSetOf<String>()
            for (src in sources) {
                try {
                    val (code, body) = fetchUrl(src, null)
                    if (code == 200) {
                        val matches = Regex("""\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}""").findAll(body)
                        matches.forEach { proxies.add(it.value) }
                    }
                } catch (_: Exception) {}
            }
            val arr = JSONArray()
            proxies.take(200).forEach { addr ->
                val obj = JSONObject()
                obj.put("address", addr)
                obj.put("type", "http")
                obj.put("status", "untested")
                arr.put(obj)
            }
            return arr.toString()
        }

        @JavascriptInterface
        fun resolveZip(zip: String): String {
            val (code, body) = fetchUrl("https://api.zippopotam.us/us/$zip", null)
            return if (code == 200) body else jsonError("ZIP not found")
        }

        @JavascriptInterface
        fun resolveCity(city: String, state: String): String {
            val query = java.net.URLEncoder.encode("$city $state USA", "UTF-8")
            val (code, body) = fetchUrl(
                "https://nominatim.openstreetmap.org/search?q=$query&format=json&limit=1",
                null,
                mapOf("Accept-Language" to "en")
            )
            return if (code == 200) body else jsonError("City not found")
        }

        @JavascriptInterface
        fun searchWindy(lat: Double, lon: Double, radius: Int): String {
            val url = "https://api.windy.com/webcams/api/v3/webcams?lang=en&limit=50&nearby=$lat,$lon,$radius&include=location,player,images"
            val (code, body) = fetchUrl(url, null, mapOf("x-windy-api-key" to "demo"))
            return if (code == 200) body else jsonError("Windy fetch failed: $code")
        }

        @JavascriptInterface
        fun searchGoogle(query: String, proxyJson: String?): String {
            Thread.sleep((1500 + (Math.random() * 2000).toLong()))
            val proxy = proxyJson?.let { parseProxy(it) }
            val encoded = java.net.URLEncoder.encode(query, "UTF-8")
            val url = "https://www.google.com/search?q=$encoded&num=20"
            val (code, body) = fetchUrl(url, proxy, mapOf(
                "Accept" to "text/html",
                "Accept-Language" to "en-US,en;q=0.9"
            ))
            return if (code == 200) body else jsonError("Google search failed: $code")
        }

        @JavascriptInterface
        fun searchBing(query: String, proxyJson: String?): String {
            Thread.sleep((1000 + (Math.random() * 1500).toLong()))
            val proxy = proxyJson?.let { parseProxy(it) }
            val encoded = java.net.URLEncoder.encode(query, "UTF-8")
            val url = "https://www.bing.com/search?q=$encoded&count=20"
            val (code, body) = fetchUrl(url, proxy)
            return if (code == 200) body else jsonError("Bing search failed: $code")
        }

        @JavascriptInterface
        fun crawlUrl(url: String, proxyJson: String?): String {
            val proxy = proxyJson?.let { parseProxy(it) }
            val (code, body) = fetchUrl(url, proxy)
            return if (code == 200) body else jsonError("Crawl failed: $code")
        }

        @JavascriptInterface
        fun saveData(key: String, value: String) {
            val prefs = getSharedPreferences("camspy", MODE_PRIVATE)
            prefs.edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun loadData(key: String): String {
            val prefs = getSharedPreferences("camspy", MODE_PRIVATE)
            return prefs.getString(key, "") ?: ""
        }

        @JavascriptInterface
        fun log(msg: String) {
            android.util.Log.d("CamSpy", msg)
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────
    private fun parseProxy(json: String): ProxyConfig? {
        return try {
            val obj = JSONObject(json)
            ProxyConfig(
                address = obj.getString("address"),
                type = obj.optString("type", "http"),
                username = obj.optString("username").ifEmpty { null },
                password = obj.optString("password").ifEmpty { null }
            )
        } catch (_: Exception) { null }
    }

    private fun parseHeaders(json: String): Map<String, String> {
        return try {
            val obj = JSONObject(json)
            val map = mutableMapOf<String, String>()
            obj.keys().forEach { key -> map[key] = obj.getString(key) }
            map
        } catch (_: Exception) { emptyMap() }
    }

    private fun jsonError(msg: String): String {
        val obj = JSONObject()
        obj.put("ok", false)
        obj.put("error", msg)
        return obj.toString()
    }

    // ─── Activity Setup ───────────────────────────────────────────────
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Full screen immersive
        window.setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        )
        window.statusBarColor = Color.parseColor("#0d0d0f")
        window.navigationBarColor = Color.parseColor("#0d0d0f")

        webView = WebView(this)
        webView.setBackgroundColor(Color.parseColor("#0d0d0f"))
        setContentView(webView)

        // WebView settings
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        // Add JavaScript bridge
        webView.addJavascriptInterface(CamSpyBridge(), "NativeBridge")

        // WebViewClient
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                // Silently handle errors - the JS handles them
            }
        }

        // WebChromeClient for geolocation
        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                callback?.invoke(origin, true, false)
            }
        }

        // Load the app
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
