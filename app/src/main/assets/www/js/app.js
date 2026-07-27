// app.js — Main CamSpy app controller

const App = (() => {
  let results = [];
  let scanning = false;
  let stopFlag = false;
  let coords = null;
  let currentCity = '';
  let currentState = '';

  const settings = {
    delay: 2000,
    jitter: 1500,
    radius: 50,
    maxResults: 20,
    rotateUA: true
  };

  // ── Init ───────────────────────────────────────────────────────
  async function init() {
    setupTabs();
    setupSearch();
    setupProxyUI();
    setupSettings();
    setupResults();

    await ProxyManager.load();
    loadResultsFromStorage();
    loadSettingsFromStorage();

    // Check public IP on startup
    setTimeout(refreshPublicIp, 800);
  }

  // ── Public IP display ──────────────────────────────────────────
  async function refreshPublicIp() {
    const ipValue = document.getElementById('ipValue');
    const ipDot = document.getElementById('ipDot');
    const locked = ProxyManager.getLockedProxy();
    const useProxy = !!(locked || ProxyManager.getMode() === 'rotate');

    ipValue.textContent = 'checking...';
    ipDot.className = 'ip-dot';

    try {
      const result = await Bridge.getPublicIp(useProxy);
      const ip = result?.ip;
      if (ip) {
        ipValue.textContent = ip;
        ipDot.className = useProxy ? 'ip-dot proxy' : 'ip-dot live';
        ipValue.className = useProxy ? 'ip-value proxied' : 'ip-value';
      } else {
        ipValue.textContent = 'unavailable';
        ipDot.className = 'ip-dot';
      }
    } catch (e) {
      ipValue.textContent = 'error';
    }
    ProxyManager.updateIPBarBadge();
  }

  // ── Tabs ───────────────────────────────────────────────────────
  function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });
  }

  // ── Search ─────────────────────────────────────────────────────
  function setupSearch() {
    document.getElementById('searchBtn').addEventListener('click', startSearch);
    document.getElementById('stopBtn').addEventListener('click', () => { stopFlag = true; });
    document.getElementById('geoBtn').addEventListener('click', useGeolocation);
    document.getElementById('locationInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') startSearch();
    });
    document.getElementById('ipRefreshBtn').addEventListener('click', refreshPublicIp);
  }

  function getSources() {
    return {
      windy: document.getElementById('srcWindy').checked,
      earthcam: document.getElementById('srcEarthcam').checked,
      google: document.getElementById('srcGoogle').checked,
      bing: document.getElementById('srcBing').checked,
      traffic: document.getElementById('srcTraffic').checked,
      crawl: document.getElementById('srcCrawl').checked,
    };
  }

  function getActiveCamTypes() {
    return Array.from(document.querySelectorAll('.camType:checked')).map(cb => cb.value);
  }

  async function startSearch() {
    if (scanning) return;
    const input = document.getElementById('locationInput').value.trim();
    if (!input) { log('📍 Enter a city, state or ZIP first!', 'error'); return; }

    log('📍 Resolving location...', 'info');
    coords = await Search.resolveLocation(input);
    if (!coords) { log('❌ Could not resolve location. Try: Miami, FL or 33101', 'error'); return; }

    currentCity = coords.city;
    currentState = coords.state;
    document.getElementById('locationResolved').textContent =
      `✅ ${coords.city}, ${coords.state} (${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)})`;

    // Check IP before scanning
    await refreshPublicIp();

    scanning = true;
    stopFlag = false;
    document.getElementById('searchBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = '';
    flashGadget();

    log(`🕵️ DEPLOYING GADGETS — ${coords.city}, ${coords.state}`, 'warn');

    const sources = getSources();
    const delay = settings.delay;
    const jitter = settings.jitter;

    // Windy
    if (sources.windy && !stopFlag) {
      log('🌬️ Querying Windy webcams...', 'info');
      const r = await Search.searchWindy(coords.lat, coords.lon, settings.radius);
      addResults(r, 'Windy');
    }

    // EarthCam
    if (sources.earthcam && !stopFlag) {
      log('🌍 Querying EarthCam...', 'info');
      const r = await Search.searchEarthCam(coords.city, coords.state);
      addResults(r, 'EarthCam');
    }

    // Google
    if (sources.google && !stopFlag) {
      const queries = [
        `"live webcam" "${coords.city} ${coords.state}" business`,
        `"webcam" "${coords.city}" restaurant bar "watch live"`,
        `"traffic camera" OR "street cam" "${coords.city} ${coords.state}"`,
      ];
      for (const q of queries) {
        if (stopFlag) break;
        log(`🔍 Google: ${q}`, 'info');
        const r = await Search.searchGoogle(q, delay, jitter);
        addResults(r, 'Google');
      }
    }

    // Bing
    if (sources.bing && !stopFlag) {
      log(`🔷 Bing: live webcam ${coords.city} ${coords.state}`, 'info');
      const r = await Search.searchBing(
        `live webcam "${coords.city} ${coords.state}" business camera`, delay, jitter
      );
      addResults(r, 'Bing');
    }

    // Traffic
    if (sources.traffic && !stopFlag) {
      log(`🚦 Checking ${coords.state} traffic cams...`, 'info');
      const r = await Search.searchTrafficCams(coords.state);
      addResults(r, 'Traffic/DOT');
    }

    // Deep crawl business results
    if (sources.crawl && !stopFlag) {
      const toCrawl = results.filter(r => r.needsCrawl).slice(0, 10);
      log(`🕷️ Deep crawling ${toCrawl.length} sites...`, 'info');
      for (const item of toCrawl) {
        if (stopFlag) break;
        await crawlResult(item.id);
      }
    }

    scanning = false;
    document.getElementById('searchBtn').style.display = '';
    document.getElementById('stopBtn').style.display = 'none';
    log(`✅ Mission complete! ${results.length} targets found.`, 'success');
    saveResultsToStorage();
  }

  async function useGeolocation() {
    if (!navigator.geolocation) { log('Geolocation not available.', 'error'); return; }
    log('📡 Getting your location...', 'info');
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      try {
        const result = await Bridge.fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
          { 'Accept-Language': 'en' }, false
        );
        if (result.success) {
          const data = JSON.parse(result.body);
          const city = data.address.city || data.address.town || data.address.village || '';
          const state = data.address.state_code || '';
          document.getElementById('locationInput').value = `${city}, ${state}`;
          coords = { lat, lon, city, state };
          document.getElementById('locationResolved').textContent =
            `✅ ${city}, ${state} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
          log(`📍 Located: ${city}, ${state}`, 'success');
        }
      } catch (e) { log('Reverse geocode failed.', 'error'); }
    }, () => log('❌ Location access denied.', 'error'));
  }

  // ── Results ─────────────────────────────────────────────────────
  function setupResults() {
    document.getElementById('filterInput').addEventListener('input', renderResults);
    document.getElementById('sortSelect').addEventListener('change', renderResults);
    document.getElementById('exportBtn').addEventListener('click', exportCSV);
  }

  function addResults(newItems, source) {
    const activeTypes = getActiveCamTypes();
    const filtered = newItems.filter(r => {
      const t = (r.type || 'other').toLowerCase();
      return activeTypes.some(at => t.includes(at));
    });
    results.push(...filtered);
    log(`📹 +${filtered.length} from ${source}`, 'source');
    renderResults();
    updateResultsBadge();
  }

  function renderResults() {
    const grid = document.getElementById('resultsGrid');
    const filter = (document.getElementById('filterInput').value || '').toLowerCase();
    const sort = document.getElementById('sortSelect').value;

    let items = [...results];
    if (filter) items = items.filter(r =>
      (r.title + r.location + r.source).toLowerCase().includes(filter)
    );
    if (sort === 'source') items.sort((a, b) => a.source.localeCompare(b.source));
    if (sort === 'live') items.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0));

    if (!items.length) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🕵️</div><div>No intel yet.<br/>Go deploy gadgets.</div></div>';
      return;
    }

    grid.innerHTML = items.map((r, i) => `
      <div class="result-card">
        <div class="card-thumb">
          ${r.thumbnail
            ? `<img src="${r.thumbnail}" alt="" onerror="this.parentElement.innerHTML='📹'" />`
            : '📹'}
        </div>
        <div class="card-body">
          <div class="card-title" title="${escHtml(r.title || '')}">${escHtml(r.title || 'Unknown Camera')}</div>
          <div class="card-tags">
            <span class="card-tag source">${escHtml(r.source || '?')}</span>
            ${r.live ? '<span class="card-tag live">🔴 LIVE</span>' : ''}
          </div>
        </div>
        <div class="card-actions">
          <button class="card-btn" onclick="App.openResult(${i})">🔗 Open</button>
          ${r.needsCrawl ? `<button class="card-btn" onclick="App.crawlItem('${r.id}')">🕷️</button>` : ''}
          <button class="card-btn" onclick="App.removeResult(${i})">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  function updateResultsBadge() {
    const badge = document.getElementById('resultsBadge');
    if (badge) {
      if (results.length > 0) {
        badge.textContent = results.length;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  window.App = {
    openResult(i) {
      const r = results[i];
      if (!r) return;
      // Open in external browser
      window.open(r.url, '_blank');
    },
    async crawlItem(id) {
      const r = results.find(x => x.id === id);
      if (!r) return;
      log(`🕷️ Crawling: ${r.url}`, 'info');
      const result = await Search.crawlSite(r.url);
      if (result.found) {
        r.live = true;
        r.type = result.type;
        r.url = result.streamUrl || r.url;
        r.needsCrawl = false;
        log(`✅ Found: ${result.type} at ${r.url}`, 'success');
        renderResults();
        saveResultsToStorage();
      } else {
        log(`❌ No webcam at ${r.url}`, 'warn');
      }
    },
    removeResult(i) {
      results.splice(i, 1);
      renderResults();
      updateResultsBadge();
      saveResultsToStorage();
    },
    refreshPublicIp,
  };

  async function crawlResult(id) {
    return window.App.crawlItem(id);
  }

  function exportCSV() {
    const csv = ['Title,Source,URL,Location,Type,Live']
      .concat(results.map(r =>
        `"${(r.title || '').replace(/"/g, '""')}","${r.source}","${r.url}","${r.location || ''}","${r.type}","${r.live}"`
      )).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `camspy_${currentCity || 'results'}.csv`;
    a.click();
  }

  // ── Proxy UI ───────────────────────────────────────────────────
  function setupProxyUI() {
    document.getElementById('modeLocked').addEventListener('click', () => ProxyManager.setMode('locked'));
    document.getElementById('modeRotate').addEventListener('click', () => ProxyManager.setMode('rotate'));

    document.getElementById('addProxiesBtn').addEventListener('click', () => {
      const text = document.getElementById('proxyInput').value;
      const count = ProxyManager.addProxiesFromText(text);
      document.getElementById('proxyInput').value = '';
      log(`➕ Added ${count} proxies.`, count > 0 ? 'success' : 'warn');
    });

    document.getElementById('fetchProxiesBtn').addEventListener('click', async () => {
      document.getElementById('fetchProxiesBtn').textContent = '⏳ Fetching...';
      document.getElementById('fetchProxiesBtn').disabled = true;
      const count = await ProxyManager.fetchFreeProxies(msg => log(msg, 'info'));
      log(`📥 Fetched ${count} new proxies.`, 'success');
      document.getElementById('fetchProxiesBtn').textContent = '📥 Fetch Free';
      document.getElementById('fetchProxiesBtn').disabled = false;
    });

    document.getElementById('testAllBtn').addEventListener('click', async () => {
      document.getElementById('testAllBtn').disabled = true;
      document.getElementById('testAllBtn').textContent = '⏳ Testing...';
      let i = 0;
      await ProxyManager.testAll((idx, total) => {
        log(`🧪 Testing proxy ${idx + 1}/${total}...`, 'info');
      });
      const ok = ProxyManager.getWorkingProxies().length;
      log(`✅ ${ok}/${ProxyManager.getProxies().length} proxies working.`, 'success');
      document.getElementById('testAllBtn').disabled = false;
      document.getElementById('testAllBtn').textContent = '🧪 Test All';
      await refreshPublicIp();
    });

    document.getElementById('clearProxiesBtn').addEventListener('click', () => {
      ProxyManager.clearAll();
      log('🗑️ Proxy list cleared.', 'warn');
      refreshPublicIp();
    });
  }

  // ── Settings ───────────────────────────────────────────────────
  function setupSettings() {
    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
    document.getElementById('clearResultsBtn').addEventListener('click', () => {
      results = [];
      renderResults();
      updateResultsBadge();
      saveResultsToStorage();
      log('🗑️ Results cleared.', 'warn');
    });
    document.getElementById('exportJsonBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `camspy_${currentCity || 'results'}.json`;
      a.click();
    });
  }

  function saveSettings() {
    settings.delay = parseInt(document.getElementById('reqDelay').value) || 2000;
    settings.jitter = parseInt(document.getElementById('reqJitter').value) || 1500;
    settings.radius = parseInt(document.getElementById('searchRadius').value) || 50;
    settings.maxResults = parseInt(document.getElementById('maxResults').value) || 20;
    settings.rotateUA = document.getElementById('rotateUA').checked;
    localStorage.setItem('camspy_settings', JSON.stringify(settings));
    log('💾 Settings saved.', 'success');
  }

  function loadSettingsFromStorage() {
    try {
      const s = JSON.parse(localStorage.getItem('camspy_settings') || '{}');
      Object.assign(settings, s);
      document.getElementById('reqDelay').value = settings.delay;
      document.getElementById('reqJitter').value = settings.jitter;
      document.getElementById('searchRadius').value = settings.radius;
      document.getElementById('maxResults').value = settings.maxResults;
      document.getElementById('rotateUA').checked = settings.rotateUA;
    } catch (e) {}
  }

  function saveResultsToStorage() {
    try { localStorage.setItem('camspy_results', JSON.stringify(results.slice(-200))); } catch (e) {}
  }

  function loadResultsFromStorage() {
    try {
      const r = JSON.parse(localStorage.getItem('camspy_results') || '[]');
      results = r;
      renderResults();
      updateResultsBadge();
    } catch (e) {}
  }

  // ── Log ─────────────────────────────────────────────────────────
  function log(msg, type = 'info') {
    const box = document.getElementById('logBox');
    if (!box) return;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${time}] ${msg}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    // Keep last 100 lines
    while (box.children.length > 100) box.removeChild(box.firstChild);
  }

  // ── Gadget easter egg ────────────────────────────────────────────
  function flashGadget() {
    const el = document.getElementById('gadgetPopup');
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { init, refreshPublicIp };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
