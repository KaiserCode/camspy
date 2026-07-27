// CamSpy Android App JS
// Talks to Kotlin via NativeBridge

// ─── State ───────────────────────────────────────────────────────────
const S = {
  results: [],
  proxies: [],
  proxyMode: 'locked',   // 'locked' | 'auto'
  activeProxyIdx: -1,
  proxyRequestCount: 0,
  scanning: false,
  aborted: false,
  coords: null,
  city: '',
  state: '',
  currentIp: null,
  settings: {
    delay: 2000, jitter: 1500,
    radius: 50, maxResults: 20, rotateUA: true
  }
};

// ─── Init ─────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  loadStorage();
  setupTabs();
  refreshIp();
});

// ─── Native Bridge helper ─────────────────────────────────────────────
const N = window.NativeBridge;

function nFetch(url, proxyOverride, headers = {}) {
  return new Promise(resolve => {
    try {
      const proxyJson = proxyOverride ? JSON.stringify(proxyOverride) : null;
      const headersJson = Object.keys(headers).length ? JSON.stringify(headers) : null;
      const raw = N.fetchHttp(url, proxyJson, headersJson);
      resolve(JSON.parse(raw));
    } catch(e) {
      resolve({ ok: false, status: 0, body: '', error: e.message });
    }
  });
}

// ─── Proxy Selector ───────────────────────────────────────────────────
function getNextProxy() {
  const working = S.proxies.filter(p => p.status === 'ok');
  if (!working.length) return null;

  if (S.proxyMode === 'locked') {
    // Use the one marked active
    if (S.activeProxyIdx >= 0 && S.proxies[S.activeProxyIdx]?.status === 'ok') {
      return S.proxies[S.activeProxyIdx];
    }
    return working[0];
  } else {
    // Auto-rotate: cycle through working proxies per-request
    S.proxyRequestCount++;
    const idx = S.proxyRequestCount % working.length;
    return working[idx];
  }
}

// ─── IP Badge ─────────────────────────────────────────────────────────
async function refreshIp() {
  const dot = document.getElementById('ip-dot');
  const txt = document.getElementById('ip-text');
  dot.className = 'ip-dot loading';
  txt.textContent = 'checking...';

  const proxy = getNextProxy();
  try {
    const raw = N.getPublicIp(proxy ? JSON.stringify(proxy) : null);
    const data = JSON.parse(raw);
    if (data.ok) {
      S.currentIp = data.ip;
      txt.textContent = data.ip;
      dot.className = proxy ? 'ip-dot proxy' : 'ip-dot ok';
      updateStatus(proxy ? `🟡 PROXY: ${proxy.address}` : '🔴 NO PROXY');
    } else {
      txt.textContent = 'error';
      dot.className = 'ip-dot error';
    }
  } catch(e) {
    txt.textContent = 'error';
    dot.className = 'ip-dot error';
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────
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

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === 'tab-' + name);
  });
}

// ─── Storage ──────────────────────────────────────────────────────────
function saveStorage() {
  try {
    N.saveData('results', JSON.stringify(S.results));
    N.saveData('proxies', JSON.stringify(S.proxies));
    N.saveData('settings', JSON.stringify(S.settings));
    N.saveData('proxyMode', S.proxyMode);
  } catch(e) {}
}

function loadStorage() {
  try {
    const r = N.loadData('results'); if (r) { S.results = JSON.parse(r); renderResults(); }
    const p = N.loadData('proxies'); if (p) { S.proxies = JSON.parse(p); renderProxyList(); }
    const s = N.loadData('settings'); if (s) { Object.assign(S.settings, JSON.parse(s)); applySettings(); }
    const m = N.loadData('proxyMode'); if (m) { setProxyMode(m); }
    updateResultCount();
  } catch(e) {}
}

// ─── Location ─────────────────────────────────────────────────────────
async function resolveLocation() {
  const input = document.getElementById('location-input').value.trim();
  if (!input) { log('Enter a location first.', 'error'); return null; }

  const tag = document.getElementById('location-tag');
  tag.textContent = '⏳ Resolving...';

  if (/^\d{5}$/.test(input)) {
    const raw = N.resolveZip(input);
    try {
      const data = JSON.parse(raw);
      if (data.places && data.places.length) {
        const p = data.places[0];
        const coords = { lat: parseFloat(p.latitude), lon: parseFloat(p.longitude),
          city: p['place name'], state: p['state abbreviation'] };
        tag.textContent = `✅ ${coords.city}, ${coords.state}`;
        return coords;
      }
    } catch(e) {}
    tag.textContent = '❌ ZIP not found';
    return null;
  } else {
    const parts = input.split(',').map(s => s.trim());
    const raw = N.resolveCity(parts[0], parts[1] || '');
    try {
      const arr = JSON.parse(raw);
      if (arr.length) {
        const coords = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon),
          city: parts[0], state: parts[1] || '' };
        tag.textContent = `✅ ${coords.city}, ${coords.state} (${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)})`;
        return coords;
      }
    } catch(e) {}
    tag.textContent = '❌ City not found. Try: Miami, FL';
    return null;
  }
}

function useGeolocation() {
  if (!navigator.geolocation) { log('Geolocation unavailable.', 'error'); return; }
  log('📡 Getting location...', 'info');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    // Reverse geocode via Nominatim
    const res = await nFetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      null, { 'Accept-Language': 'en' }
    );
    if (res.ok) {
      try {
        const data = JSON.parse(res.body);
        const city = data.address.city || data.address.town || data.address.village || 'Unknown';
        const state = data.address.state_code || '';
        document.getElementById('location-input').value = `${city}, ${state}`;
        S.coords = { lat, lon, city, state };
        document.getElementById('location-tag').textContent = `✅ ${city}, ${state}`;
        log(`📍 Located: ${city}, ${state}`, 'success');
      } catch(e) { log('Could not reverse geocode.', 'error'); }
    }
  }, () => log('Location permission denied.', 'error'));
}

// ─── Search ───────────────────────────────────────────────────────────
async function startSearch() {
  if (S.scanning) return;
  S.aborted = false;

  const coords = await resolveLocation();
  if (!coords) return;
  S.coords = coords;

  // Check IP before starting so user can see what proxy is active
  await refreshIp();

  S.scanning = true;
  document.getElementById('search-btn').style.display = 'none';
  document.getElementById('stop-btn').style.display = '';
  updateScanStatus('🔍 SCANNING...');
  log(`🕵️ DEPLOYING for ${coords.city}, ${coords.state}...`, 'warn');

  const sources = {
    windy: document.getElementById('src-windy').checked,
    earthcam: document.getElementById('src-earthcam').checked,
    google: document.getElementById('src-google').checked,
    bing: document.getElementById('src-bing').checked,
    traffic: document.getElementById('src-traffic').checked,
    crawl: document.getElementById('src-crawl').checked
  };

  if (sources.windy) await searchWindy(coords);
  if (S.aborted) return finishSearch();

  if (sources.earthcam) await searchEarthCam(coords.city, coords.state);
  if (S.aborted) return finishSearch();

  if (sources.google) await searchGoogle(coords);
  if (S.aborted) return finishSearch();

  if (sources.bing) await searchBing(coords);
  if (S.aborted) return finishSearch();

  if (sources.traffic) await searchTraffic(coords.state);

  finishSearch();
}

function stopSearch() {
  S.aborted = true;
  log('✋ Aborted.', 'warn');
}

function finishSearch() {
  S.scanning = false;
  document.getElementById('search-btn').style.display = '';
  document.getElementById('stop-btn').style.display = 'none';
  updateScanStatus('✅ DONE');
  log(`✅ Complete. ${S.results.length} cams found.`, 'success');
  saveStorage();
  // Auto-switch to results
  switchTab('results');
}

// ─── Source: Windy ────────────────────────────────────────────────────
async function searchWindy(coords) {
  log('🌬️ Querying Windy...', 'source');
  const r = S.settings.radius;
  const url = `https://api.windy.com/webcams/api/v3/webcams?lang=en&limit=50&nearby=${coords.lat},${coords.lon},${r}&include=location,player,images`;
  const res = await nFetch(url, getNextProxy(), { 'x-windy-api-key': 'demo' });
  if (!res.ok) { log(`⚠️ Windy: ${res.status || res.error}`, 'warn'); return; }
  try {
    const data = JSON.parse(res.body);
    const cams = (data.webcams || []).map(c => ({
      id: 'windy_' + c.webcamId,
      source: 'Windy', title: c.title || 'Windy Webcam',
      url: c.player?.day?.embed || c.player?.live?.embed || '',
      thumbnail: c.images?.current?.preview || '',
      location: `${c.location?.city || ''}, ${c.location?.region || ''}`,
      type: 'weather', live: !!c.player?.live
    }));
    addResults(cams, 'Windy');
  } catch(e) { log('⚠️ Windy parse error', 'warn'); }
}

// ─── Source: EarthCam ─────────────────────────────────────────────────
async function searchEarthCam(city, state) {
  log('🌍 Querying EarthCam...', 'source');
  const q = encodeURIComponent(`${city} ${state}`);
  const res = await nFetch(`https://www.earthcam.com/search/?q=${q}`, getNextProxy());
  if (!res.ok) { log(`⚠️ EarthCam: ${res.status}`, 'warn'); return; }
  const cams = [];
  const regex = /href="(\/[^"]+)"[^>]*>[\s\S]*?class="[^"]*cam-title[^"]*"[^>]*>([\s\S]*?)<\//gi;
  let m;
  while ((m = regex.exec(res.body)) !== null && cams.length < 20) {
    cams.push({
      id: 'earthcam_' + cams.length,
      source: 'EarthCam', title: m[2].replace(/<[^>]+>/g, '').trim(),
      url: 'https://www.earthcam.com' + m[1], thumbnail: '',
      location: `${city}, ${state}`, type: 'city', live: true
    });
  }
  addResults(cams, 'EarthCam');
}

// ─── Source: Google ───────────────────────────────────────────────────
async function searchGoogle(coords) {
  const queries = [
    `"live webcam" "${coords.city} ${coords.state}"`,
    `"webcam" "${coords.city}" restaurant bar beach live`,
  ];
  for (const q of queries) {
    if (S.aborted) break;
    log(`🔍 Google: ${q}`, 'source');
    await sleep(S.settings.delay + rand(S.settings.jitter));
    const proxy = getNextProxy();
    try {
      const raw = N.searchGoogle(q, proxy ? JSON.stringify(proxy) : null);
      parseSearchHtml(raw, 'Google', coords);
    } catch(e) { log(`⚠️ Google error: ${e.message}`, 'warn'); }
  }
}

// ─── Source: Bing ─────────────────────────────────────────────────────
async function searchBing(coords) {
  log(`🔷 Bing search...`, 'source');
  await sleep(S.settings.delay + rand(S.settings.jitter));
  const proxy = getNextProxy();
  try {
    const q = `live webcam "${coords.city} ${coords.state}" business`;
    const raw = N.searchBing(q, proxy ? JSON.stringify(proxy) : null);
    parseSearchHtml(raw, 'Bing', coords);
  } catch(e) { log(`⚠️ Bing error: ${e.message}`, 'warn'); }
}

function parseSearchHtml(html, source, coords) {
  const results = [];
  // Extract links
  const linkRe = /href="(https?:\/\/(?!(?:www\.)?(google|bing|microsoft)\.[^/])[^"&]+)"/g;
  const titleRe = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
  const links = [], titles = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) links.push(m[1]);
  while ((m = titleRe.exec(html)) !== null) titles.push(m[1].replace(/<[^>]+>/g, '').trim());
  for (let i = 0; i < Math.min(links.length, 10); i++) {
    results.push({
      id: `${source.toLowerCase()}_${i}_${Date.now()}`,
      source, title: titles[i] || links[i],
      url: links[i], thumbnail: '',
      location: `${coords.city}, ${coords.state}`,
      type: 'business', live: null, needsCrawl: true
    });
  }
  addResults(results, source);
}

// ─── Source: Traffic ──────────────────────────────────────────────────
async function searchTraffic(state) {
  log('🚦 Checking traffic feeds...', 'source');
  const feeds = {
    'CA': 'https://511.org/open-data/traffic',
    'NY': 'https://511ny.org/api/getevents?format=json',
    'WA': 'https://www.wsdot.wa.gov/Traffic/api/Cameras/CameraLocation',
    'TX': 'https://www.txdot.gov/apps/travel_map',
    'FL': 'https://fl511.com/map'
  };
  const su = (state || '').toUpperCase();
  if (feeds[su]) {
    addResults([{
      id: `traffic_${su}`,
      source: 'Traffic/DOT', title: `${su} DOT Traffic Cameras`,
      url: feeds[su], thumbnail: '',
      location: state, type: 'traffic', live: true
    }], 'Traffic');
  }
}

// ─── Crawl ────────────────────────────────────────────────────────────
async function crawlResult(idx) {
  const r = S.results[idx];
  if (!r) return;
  log(`🕷️ Crawling ${r.url}...`, 'info');
  const proxy = getNextProxy();
  try {
    const raw = N.crawlUrl(r.url, proxy ? JSON.stringify(proxy) : null);
    const lower = raw.toLowerCase();
    const patterns = [
      { re: /mjpg|mjpeg|video\.cgi|webcam|livecam/i, type: 'MJPEG Stream' },
      { re: /\.m3u8/i, type: 'HLS Stream' },
      { re: /youtube\.com\/embed/i, type: 'YouTube Live' },
      { re: /<video[^>]+src/i, type: 'HTML5 Video' },
      { re: /rtsp:\/\//i, type: 'RTSP Stream' },
      { re: /live.?cam|livefeed|live.?feed/i, type: 'Webcam Page' }
    ];
    for (const { re, type } of patterns) {
      if (re.test(raw)) {
        const m3u8 = raw.match(/https?:\/\/[^\s"']+\.m3u8/i);
        const mjpg = raw.match(/https?:\/\/[^\s"']+mjp[ge]+[^\s"']*/i);
        S.results[idx] = { ...r, live: true, type,
          url: m3u8?.[0] || mjpg?.[0] || r.url, needsCrawl: false };
        log(`✅ Found ${type} at ${r.url}`, 'success');
        renderResults();
        saveStorage();
        return;
      }
    }
    log(`❌ No webcam at ${r.url}`, 'warn');
  } catch(e) { log(`⚠️ Crawl error: ${e.message}`, 'warn'); }
}

// ─── Results ──────────────────────────────────────────────────────────
function addResults(items, source) {
  const activeTypes = Array.from(document.querySelectorAll('.cam-type:checked')).map(cb => cb.value);
  const filtered = items.filter(r => {
    const t = (r.type || 'other').toLowerCase();
    return activeTypes.some(at => t.includes(at));
  });
  // Dedupe by URL
  filtered.forEach(r => {
    if (!S.results.find(x => x.url === r.url)) S.results.push(r);
  });
  log(`📹 +${filtered.length} from ${source}`, 'source');
  renderResults();
  updateResultCount();
}

function renderResults() {
  const grid = document.getElementById('results-grid');
  const filter = (document.getElementById('results-filter')?.value || '').toLowerCase();
  let items = [...S.results];
  if (filter) items = items.filter(r =>
    (r.title||'').toLowerCase().includes(filter) ||
    (r.location||'').toLowerCase().includes(filter) ||
    (r.source||'').toLowerCase().includes(filter)
  );
  if (!items.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🕵️</div>No intel yet.<br/>Deploy gadgets first.</div>';
    return;
  }
  grid.innerHTML = items.map((r, i) => `
    <div class="result-card" style="animation-delay:${i*0.04}s">
      <div class="card-thumb">
        ${r.thumbnail ? `<img src="${r.thumbnail}" onerror="this.parentElement.innerHTML='📹'"/>` : '📹'}
      </div>
      <div class="card-body">
        <div class="card-title">${r.title || 'Unknown Camera'}</div>
        <div class="card-meta">
          <span class="badge badge-source">${r.source}</span>
          ${r.live ? '<span class="badge badge-live">🔴 LIVE</span>' : ''}
          <span>${r.location || ''}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="card-act" onclick="openUrl('${encodeURIComponent(r.url)}')">🔗 Open</button>
        ${r.needsCrawl ? `<button class="card-act" onclick="crawlResult(${S.results.indexOf(r)})">🕷️ Crawl</button>` : ''}
        <button class="card-act" onclick="removeResult(${S.results.indexOf(r)})">🗑️</button>
      </div>
    </div>
  `).join('');
}

function openUrl(encoded) {
  window.open(decodeURIComponent(encoded), '_blank');
}

function removeResult(i) {
  S.results.splice(i, 1);
  renderResults();
  updateResultCount();
  saveStorage();
}

function clearResults() {
  S.results = [];
  renderResults();
  updateResultCount();
  saveStorage();
  log('🗑️ Results cleared.', 'warn');
}

function updateResultCount() {
  document.getElementById('result-count').textContent = `📹 ${S.results.length}`;
}

function exportCSV() {
  const csv = ['Title,Source,URL,Location,Type,Live']
    .concat(S.results.map(r => `"${r.title}","${r.source}","${r.url}","${r.location}","${r.type}","${r.live}"`))
    .join('\n');
  const b64 = btoa(unescape(encodeURIComponent(csv)));
  const a = document.createElement('a');
  a.href = 'data:text/csv;base64,' + b64;
  a.download = 'camspy_results.csv';
  a.click();
}

function exportJSON() {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(S.results, null, 2))));
  const a = document.createElement('a');
  a.href = 'data:application/json;base64,' + b64;
  a.download = 'camspy_results.json';
  a.click();
}

// ─── Proxies ──────────────────────────────────────────────────────────
function setProxyMode(mode) {
  S.proxyMode = mode;
  document.getElementById('mode-locked').classList.toggle('active', mode === 'locked');
  document.getElementById('mode-auto').classList.toggle('active', mode === 'auto');
  document.getElementById('mode-desc').textContent = mode === 'locked'
    ? 'All requests use the same proxy. Tap USE on a proxy to activate it.'
    : 'Automatically rotates through working proxies on each request for maximum stealth.';
  saveStorage();
  refreshIp();
}

function addProxies() {
  const text = document.getElementById('proxy-input').value.trim();
  if (!text) return;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0;
  lines.forEach(line => {
    let type = 'http', address = line;
    if (line.startsWith('socks5://')) { type = 'socks5'; address = line.replace('socks5://', ''); }
    else if (line.startsWith('http://')) { address = line.replace('http://', ''); }
    if (!S.proxies.find(p => p.address === address)) {
      S.proxies.push({ address, type, status: 'untested' });
      added++;
    }
  });
  document.getElementById('proxy-input').value = '';
  renderProxyList();
  saveStorage();
  log(`➕ Added ${added} proxies.`, 'success');
}

async function fetchFreeProxies() {
  const btn = document.getElementById('fetch-btn');
  btn.textContent = '⏳ Fetching...';
  btn.disabled = true;
  log('📥 Fetching free proxies...', 'info');
  try {
    const raw = N.fetchFreeProxies();
    const arr = JSON.parse(raw);
    let added = 0;
    arr.forEach(p => {
      if (!S.proxies.find(x => x.address === p.address)) {
        S.proxies.push(p); added++;
      }
    });
    renderProxyList();
    saveStorage();
    log(`📥 Fetched ${added} new proxies.`, 'success');
  } catch(e) { log(`⚠️ Fetch error: ${e.message}`, 'error'); }
  btn.textContent = '📥 Fetch Free';
  btn.disabled = false;
  document.getElementById('proxy-count').textContent = `(${S.proxies.length})`;
}

async function testAllProxies() {
  const btn = document.getElementById('test-btn');
  btn.textContent = '⏳ Testing...';
  btn.disabled = true;
  log(`🧪 Testing ${S.proxies.length} proxies...`, 'info');
  for (let i = 0; i < S.proxies.length; i++) {
    S.proxies[i].status = 'testing';
    renderProxyList();
    try {
      const raw = N.testProxy(JSON.stringify(S.proxies[i]));
      const result = JSON.parse(raw);
      S.proxies[i] = { ...S.proxies[i], ...result };
      if (result.ok) {
        log(`✅ ${S.proxies[i].address} — ${result.latency}ms (${result.ip})`, 'success');
      } else {
        log(`❌ ${S.proxies[i].address} — dead`, 'error');
      }
    } catch(e) {
      S.proxies[i].status = 'dead';
    }
    renderProxyList();
  }
  saveStorage();
  const ok = S.proxies.filter(p => p.status === 'ok').length;
  log(`🧪 Done. ${ok}/${S.proxies.length} working.`, 'warn');
  btn.textContent = '🧪 Test All';
  btn.disabled = false;
}

function clearProxies() {
  S.proxies = [];
  S.activeProxyIdx = -1;
  renderProxyList();
  saveStorage();
  updateStatus('🔴 NO PROXY');
  refreshIp();
}

function useProxy(i) {
  S.proxies.forEach((p, idx) => p.active = idx === i);
  S.activeProxyIdx = i;
  renderProxyList();
  saveStorage();
  const p = S.proxies[i];
  updateStatus(`🟡 ${p.address}`);
  log(`🧥 Using proxy: ${p.address}`, 'success');
  refreshIp();
}

function removeProxy(i) {
  S.proxies.splice(i, 1);
  if (S.activeProxyIdx === i) S.activeProxyIdx = -1;
  renderProxyList();
  saveStorage();
}

function renderProxyList() {
  const list = document.getElementById('proxy-list');
  document.getElementById('proxy-count').textContent = `(${S.proxies.length})`;
  if (!S.proxies.length) {
    list.innerHTML = '<div class="empty-state" style="padding:16px">No proxies loaded.</div>';
    return;
  }
  list.innerHTML = S.proxies.map((p, i) => `
    <div class="proxy-item ${p.status} ${p.active ? 'active-proxy' : ''}">
      <span>${p.status==='ok'?'🟢':p.status==='dead'?'🔴':p.status==='testing'?'🟡':'⚪'}</span>
      <span class="proxy-addr">${p.type!=='http'?p.type+'://':''}${p.address}</span>
      ${p.latency ? `<span class="proxy-lat">${p.latency}ms</span>` : ''}
      <button class="pact-btn" onclick="useProxy(${i})">USE</button>
      <button class="pact-btn" style="color:var(--red)" onclick="removeProxy(${i})">✕</button>
    </div>
  `).join('');
}

// ─── Settings ─────────────────────────────────────────────────────────
function applySettings() {
  document.getElementById('req-delay').value = S.settings.delay;
  document.getElementById('req-jitter').value = S.settings.jitter;
  document.getElementById('search-radius').value = S.settings.radius;
  document.getElementById('max-results').value = S.settings.maxResults;
  document.getElementById('rotate-ua').checked = S.settings.rotateUA;
}

function saveSettings() {
  S.settings = {
    delay: parseInt(document.getElementById('req-delay').value) || 2000,
    jitter: parseInt(document.getElementById('req-jitter').value) || 1500,
    radius: parseInt(document.getElementById('search-radius').value) || 50,
    maxResults: parseInt(document.getElementById('max-results').value) || 20,
    rotateUA: document.getElementById('rotate-ua').checked
  };
  saveStorage();
  log('💾 Settings saved.', 'success');
}

// ─── Log ──────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const box = document.getElementById('search-log');
  if (!box) return;
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  const el = document.createElement('span');
  el.className = `log-entry ${type}`;
  el.textContent = `[${t}] ${msg}\n`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  try { N.log(msg); } catch(e) {}
}

// ─── Status helpers ────────────────────────────────────────────────────
function updateStatus(proxyMsg) {
  if (proxyMsg) document.getElementById('proxy-status').textContent = proxyMsg;
}
function updateScanStatus(msg) {
  document.getElementById('scan-status').textContent = msg;
}

// ─── Utilities ────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(max) { return Math.floor(Math.random() * max); }
