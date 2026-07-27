// bridge.js — Promise wrapper around CamSpyNative Java bridge
// Makes native calls feel like async/await

const Bridge = (() => {
  const callbacks = {};
  let callbackId = 0;

  // Called by native Kotlin with results
  window.__camspyCallback = (id, data) => {
    const cb = callbacks[id];
    if (cb) {
      delete callbacks[id];
      if (data && data.error) cb.reject(new Error(data.error));
      else cb.resolve(data);
    }
  };

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = `cb_${++callbackId}`;
      callbacks[id] = { resolve, reject };
      try {
        CamSpyNative[method](id, ...args);
      } catch (e) {
        // Fallback for browser testing (no native bridge)
        delete callbacks[id];
        reject(new Error(`Native bridge unavailable: ${e.message}`));
      }
    });
  }

  function callVoid(method, ...args) {
    try {
      CamSpyNative[method](...args);
    } catch (e) {
      console.warn(`Native bridge unavailable: ${e.message}`);
    }
  }

  const isNative = typeof CamSpyNative !== 'undefined';

  return {
    isNative,

    // Fetch a URL via native HTTP (bypasses CORS)
    async fetch(url, headers = {}, useProxy = true) {
      if (!isNative) {
        // Browser fallback - limited by CORS
        const res = await fetch(url, { headers });
        const body = await res.text();
        return { success: res.ok, body, statusCode: res.status, proxyUsed: null };
      }
      return call('fetch', url, JSON.stringify(headers), useProxy);
    },

    // Get public IP (through proxy if active)
    async getPublicIp(useProxy = true) {
      if (!isNative) {
        const res = await fetch('https://api.ipify.org?format=json');
        const d = await res.json();
        return { ip: d.ip };
      }
      return call('getPublicIp', useProxy);
    },

    // Test a proxy
    async testProxy(proxy) {
      if (!isNative) return { ...proxy, status: 'dead' };
      return call('testProxy', JSON.stringify(proxy));
    },

    // Fetch free proxy lists
    async fetchFreeProxies() {
      if (!isNative) return [];
      return call('fetchFreeProxies');
    },

    // Set proxy mode
    setProxyMode(mode) {
      callVoid('setProxyMode', mode); // 'locked' or 'rotate'
    },

    // Set the locked proxy
    setLockedProxy(proxy) {
      callVoid('setLockedProxy', proxy ? JSON.stringify(proxy) : null);
    },

    // Update full proxy list for rotation
    updateProxyList(proxies) {
      callVoid('updateProxyList', JSON.stringify(proxies));
    },

    // Load saved proxies
    async loadProxies() {
      if (!isNative) return [];
      return call('loadProxies');
    },

    // Get proxy status
    async getProxyStatus() {
      if (!isNative) return { mode: 'locked', lockedProxy: null, proxyCount: 0, workingCount: 0 };
      return call('getProxyStatus');
    }
  };
})();
