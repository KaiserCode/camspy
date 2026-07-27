package com.camspy.app

import android.webkit.JavascriptInterface
import com.google.gson.Gson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

class CamSpyBridge(
    private val http: NativeHttpEngine,
    private val scope: CoroutineScope,
    private val gson: Gson,
    private val evalJs: (String) -> Unit
) {

    private fun callback(callbackId: String, data: Any?) {
        val json = gson.toJson(data)
        evalJs("window.__camspyCallback('$callbackId', $json)")
    }

    private fun callbackError(callbackId: String, error: String) {
        evalJs("window.__camspyCallback('$callbackId', {error: '${error.replace("'", "\\'")}'})")
    }

    // ── Fetch a URL natively (bypasses CORS) ──────────────────────
    @JavascriptInterface
    fun fetch(callbackId: String, url: String, headersJson: String, useProxy: Boolean) {
        scope.launch {
            try {
                val headers: Map<String, String> = try {
                    gson.fromJson(headersJson, Map::class.java) as Map<String, String>
                } catch (e: Exception) { emptyMap() }

                val result = http.fetch(url, headers, useProxy)
                callback(callbackId, mapOf(
                    "success" to result.success,
                    "body" to (result.body ?: ""),
                    "statusCode" to result.statusCode,
                    "error" to result.error,
                    "proxyUsed" to result.proxyUsed
                ))
            } catch (e: Exception) {
                callbackError(callbackId, e.message ?: "Unknown error")
            }
        }
    }

    // ── Get current public IP ──────────────────────────────────────
    @JavascriptInterface
    fun getPublicIp(callbackId: String, useProxy: Boolean) {
        scope.launch {
            val ip = http.getPublicIp(useProxy)
            callback(callbackId, mapOf("ip" to ip))
        }
    }

    // ── Test a proxy ───────────────────────────────────────────────
    @JavascriptInterface
    fun testProxy(callbackId: String, proxyJson: String) {
        scope.launch {
            try {
                val proxy = gson.fromJson(proxyJson, ProxyConfig::class.java)
                val result = http.testProxy(proxy)
                callback(callbackId, result)
            } catch (e: Exception) {
                callbackError(callbackId, e.message ?: "Parse error")
            }
        }
    }

    // ── Fetch free proxies from public lists ───────────────────────
    @JavascriptInterface
    fun fetchFreeProxies(callbackId: String) {
        scope.launch {
            val proxies = http.fetchFreeProxies()
            callback(callbackId, proxies)
        }
    }

    // ── Set proxy mode ─────────────────────────────────────────────
    @JavascriptInterface
    fun setProxyMode(mode: String) {
        http.proxyMode = when (mode) {
            "rotate" -> ProxyMode.AUTO_ROTATE
            else -> ProxyMode.LOCKED
        }
    }

    // ── Set locked proxy ───────────────────────────────────────────
    @JavascriptInterface
    fun setLockedProxy(proxyJson: String?) {
        http.lockedProxy = if (proxyJson == null || proxyJson == "null") null
        else try { gson.fromJson(proxyJson, ProxyConfig::class.java) } catch (e: Exception) { null }
    }

    // ── Update full proxy list (for rotation) ──────────────────────
    @JavascriptInterface
    fun updateProxyList(proxiesJson: String) {
        try {
            val proxies = gson.fromJson(proxiesJson, Array<ProxyConfig>::class.java).toList()
            http.proxyList.clear()
            http.proxyList.addAll(proxies)
            http.saveProxies()
        } catch (e: Exception) {
            android.util.Log.e("CamSpy", "Failed to update proxy list: ${e.message}")
        }
    }

    // ── Load saved proxies ─────────────────────────────────────────
    @JavascriptInterface
    fun loadProxies(callbackId: String) {
        val proxies = http.loadProxies()
        http.proxyList.clear()
        http.proxyList.addAll(proxies)
        callback(callbackId, proxies)
    }

    // ── Get proxy status ───────────────────────────────────────────
    @JavascriptInterface
    fun getProxyStatus(callbackId: String) {
        callback(callbackId, mapOf(
            "mode" to http.proxyMode.name.lowercase(),
            "lockedProxy" to http.lockedProxy,
            "proxyCount" to http.proxyList.size,
            "workingCount" to http.proxyList.count { it.status == "ok" }
        ))
    }

    // ── Save data to native SharedPrefs ───────────────────────────
    @JavascriptInterface
    fun saveData(key: String, value: String) {
        val prefs = android.app.Application().getSharedPreferences("camspy_data", 0)
        // Use application context via a workaround
        evalJs("window.__nativeStorageSave('$key')")
    }
}
