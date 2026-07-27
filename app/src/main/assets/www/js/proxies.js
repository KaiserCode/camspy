// proxies.js — Proxy management UI and logic

const ProxyManager = (() => {
  let proxies = [];
  let mode = 'locked'; // 'locked' | 'rotate'
  let lockedProxy = null;

  function getMode() { return mode; }
  function getProxies() { return proxies; }
  function getLockedProxy() { return lockedProxy; }
  function getWorkingProxies() { return proxies.filter(p => p.status === 'ok'); }

  function setMode(m) {
    mode = m;
    Bridge.setProxyMode(m);
    document.getElementById('modeLocked').classList.toggle('active', m === 'locked');
    document.getElementById('modeRotate').classList.toggle('active', m === 'rotate');
    document.getElementById('modeDesc').textContent = m === 'rotate'
      ? `Auto-rotating through ${getWorkingProxies().length} working proxies per-request.`
      : lockedProxy
        ? `Locked to: ${lockedProxy.address}:${lockedProxy.port}`
        : 'No proxy locked. Requests use direct connection.';
    updateIPBarBadge();
  }

  function lockProxy(proxy) {
    lockedProxy = proxy;
    proxies.forEach(p => p.active = false);
    if (proxy) proxy.active = true;
    Bridge.setLockedProxy(proxy);
    setMode('locked');
    render();
    App?.refreshPublicIp();
  }

  function addProxiesFromText(text) {
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const newProxies = lines.map(line => {
      let type = 'http', address = line, username = null, password = null;
      if (line.startsWith('socks5://')) { type = 'socks5'; address = line.replace('socks5://', ''); }
      else if (line.startsWith('http://')) { address = line.replace('http://', ''); }
      // Handle user:pass@host:port
      if (address.includes('@')) {
        const [auth, hostPort] = address.split('@');
        address = hostPort;
        const [u, p] = auth.split(':');
        username = u; password = p || null;
      }
      const [host, portStr] = address.split(':');
      const port = parseInt(portStr) || 8080;
      return { address: host, port, type, username, password, status: 'untested' };
    });
    const existing = new Set(proxies.map(p => `${p.address}:${p.port}`));
    const fresh = newProxies.filter(p => !existing.has(`${p.address}:${p.port}`));
    proxies.push(...fresh);
    Bridge.updateProxyList(proxies);
    render();
    updateBadge();
    return fresh.length;
  }

  async function fetchFreeProxies(onProgress) {
    onProgress?.('Fetching free proxies from public lists...');
    const result = await Bridge.fetchFreeProxies();
    const list = Array.isArray(result) ? result : [];
    const existing = new Set(proxies.map(p => `${p.address}:${p.port}`));
    const fresh = list.filter(p => !existing.has(`${p.address}:${p.port}`));
    proxies.push(...fresh);
    Bridge.updateProxyList(proxies);
    render();
    updateBadge();
    return fresh.length;
  }

  async function testProxy(proxy, index) {
    proxy.status = 'testing';
    render();
    const result = await Bridge.testProxy(proxy);
    proxies[index] = { ...proxy, ...result };
    render();
    updateBadge();
    Bridge.updateProxyList(proxies);
    return proxies[index];
  }

  async function testAll(onProgress) {
    for (let i = 0; i < proxies.length; i++) {
      onProgress?.(i, proxies.length);
      await testProxy(proxies[i], i);
    }
    setMode(mode); // refresh desc
  }

  function clearAll() {
    proxies = [];
    lockedProxy = null;
    Bridge.setLockedProxy(null);
    Bridge.updateProxyList([]);
    render();
    updateBadge();
    updateIPBarBadge();
  }

  function removeProxy(index) {
    if (proxies[index]?.active) {
      lockedProxy = null;
      Bridge.setLockedProxy(null);
    }
    proxies.splice(index, 1);
    Bridge.updateProxyList(proxies);
    render();
    updateBadge();
  }

  async function load() {
    const result = await Bridge.loadProxies();
    if (Array.isArray(result) && result.length) {
      proxies = result;
      lockedProxy = proxies.find(p => p.active) || null;
      if (lockedProxy) Bridge.setLockedProxy(lockedProxy);
      render();
      updateBadge();
    }
  }

  function render() {
    const list = document.getElementById('proxyList');
    const stats = document.getElementById('proxyStats');
    const ok = proxies.filter(p => p.status === 'ok').length;
    const dead = proxies.filter(p => p.status === 'dead').length;

    if (stats) stats.textContent = `${ok} ok / ${proxies.length} total`;

    if (!proxies.length) {
      list.innerHTML = '<div class="empty-state small">No proxies. Fetch free ones or paste above.</div>';
      return;
    }

    list.innerHTML = proxies.map((p, i) => {
      const statusIcon = p.status === 'ok' ? '🟢' : p.status === 'dead' ? '🔴' : p.status === 'testing' ? '🟡' : '⚪';
      const isActive = p.active;
      return `<div class="proxy-item ${p.status} ${isActive ? 'active-proxy' : ''}">
        <span>${statusIcon}</span>
        <span class="proxy-addr" title="${p.type}://${p.address}:${p.port}">${p.type !== 'http' ? p.type + '://' : ''}${p.address}:${p.port}</span>
        ${p.latencyMs ? `<span class="proxy-lat">${p.latencyMs}ms</span>` : ''}
        ${p.publicIp ? `<span class="proxy-ip">${p.publicIp}</span>` : ''}
        <button class="proxy-use-btn ${isActive ? 'active-use' : ''}" onclick="ProxyManager.lock(${i})">
          ${isActive ? '✓ USING' : 'USE'}
        </button>
        <button class="proxy-del-btn" onclick="ProxyManager.remove(${i})">✕</button>
      </div>`;
    }).join('');
  }

  function updateBadge() {
    const ok = proxies.filter(p => p.status === 'ok').length;
    const badge = document.getElementById('proxyBadgeCount');
    if (badge) {
      if (proxies.length > 0) {
        badge.textContent = ok || proxies.length;
        badge.style.display = '';
        badge.style.background = ok > 0 ? '' : '#ff3333';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  function updateIPBarBadge() {
    const badge = document.getElementById('proxyBadge');
    if (!badge) return;
    if (mode === 'rotate') {
      const ok = getWorkingProxies().length;
      badge.textContent = `↻ ROTATE (${ok})`;
      badge.className = 'ip-proxy-badge rotate';
    } else if (lockedProxy) {
      badge.textContent = `🔒 ${lockedProxy.address}:${lockedProxy.port}`;
      badge.className = 'ip-proxy-badge active';
    } else {
      badge.textContent = 'NO PROXY';
      badge.className = 'ip-proxy-badge';
    }
  }

  // Public API
  return {
    load, render, getMode, getProxies, getLockedProxy, getWorkingProxies,
    setMode, lockProxy, addProxiesFromText, fetchFreeProxies,
    testProxy, testAll, clearAll, removeProxy, updateIPBarBadge,
    lock: lockProxy,
    remove: removeProxy,
  };
})();
