// search.js — Webcam source scrapers using native HTTP bridge

const Search = (() => {

  const userAgents = [
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
  ];

  function randomUA() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── ZIP → Coordinates ────────────────────────────────────────────
  async function zipToCoords(zip) {
    const result = await Bridge.fetch(`https://api.zippopotam.us/us/${zip}`, {}, false);
    if (!result.success || !result.body) return null;
    try {
      const data = JSON.parse(result.body);
      if (!data.places?.length) return null;
      return {
        lat: parseFloat(data.places[0].latitude),
        lon: parseFloat(data.places[0].longitude),
        city: data.places[0]['place name'],
        state: data.places[0]['state abbreviation']
      };
    } catch (e) { return null; }
  }

  // ── City → Coordinates ───────────────────────────────────────────
  async function cityToCoords(city, state) {
    const q = encodeURIComponent(`${city}${state ? ', ' + state : ''}, USA`);
    const result = await Bridge.fetch(
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`,
      { 'Accept-Language': 'en' }, false
    );
    if (!result.success || !result.body) return null;
    try {
      const data = JSON.parse(result.body);
      if (!data.length) return null;
      return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), city, state };
    } catch (e) { return null; }
  }

  async function resolveLocation(input) {
    input = input.trim();
    if (/^\d{5}$/.test(input)) return zipToCoords(input);
    const parts = input.split(',').map(s => s.trim());
    return cityToCoords(parts[0], parts[1] || '');
  }

  // ── Source: Windy Webcams ────────────────────────────────────────
  async function searchWindy(lat, lon, radius = 50) {
    try {
      const url = `https://api.windy.com/webcams/api/v3/webcams?lang=en&limit=50&nearby=${lat},${lon},${radius}&include=location,player,images`;
      const result = await Bridge.fetch(url, { 'x-windy-api-key': 'demo' });
      if (!result.success) return [];
      const data = JSON.parse(result.body);
      return (data.webcams || []).map(c => ({
        id: `windy_${c.webcamId}`,
        source: 'Windy',
        title: c.title || 'Windy Webcam',
        url: c.player?.day?.embed || c.player?.live?.embed || `https://windy.com/webcams/${c.webcamId}`,
        thumbnail: c.images?.current?.preview || '',
        location: `${c.location?.city || ''}, ${c.location?.region || ''}`,
        type: 'weather',
        live: !!c.player?.live
      }));
    } catch (e) { return []; }
  }

  // ── Source: EarthCam ─────────────────────────────────────────────
  async function searchEarthCam(city, state) {
    try {
      const url = `https://www.earthcam.com/search/?q=${encodeURIComponent(city + ' ' + state)}`;
      const result = await Bridge.fetch(url, { 'User-Agent': randomUA() });
      if (!result.success || !result.body) return [];
      const html = result.body;
      const results = [];
      const regex = /href="(\/[^"?]+)"[^>]*>[\s\S]{0,200}?class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\//gi;
      let m;
      while ((m = regex.exec(html)) !== null && results.length < 15) {
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        if (title) results.push({
          id: `earthcam_${results.length}`,
          source: 'EarthCam',
          title,
          url: `https://www.earthcam.com${m[1]}`,
          thumbnail: '',
          location: `${city}, ${state}`,
          type: 'city',
          live: true
        });
      }
      return results;
    } catch (e) { return []; }
  }

  // ── Source: Google Search Scrape ─────────────────────────────────
  async function searchGoogle(query, delay = 2000, jitter = 1500) {
    await sleep(delay + Math.random() * jitter);
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en`;
      const result = await Bridge.fetch(url, {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      });
      if (!result.success || !result.body) return [];
      const html = result.body;
      const results = [];
      const linkRx = /href="(https?:\/\/(?!google|gstatic|youtube\.com\/watch)[^"&]+)"/g;
      const titleRx = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
      const links = [], titles = [];
      let m;
      while ((m = linkRx.exec(html)) !== null) links.push(m[1]);
      while ((m = titleRx.exec(html)) !== null) titles.push(m[1].replace(/<[^>]+>/g, '').trim());
      for (let i = 0; i < Math.min(links.length, 10); i++) {
        results.push({
          id: `google_${Date.now()}_${i}`,
          source: 'Google',
          title: titles[i] || links[i],
          url: links[i],
          thumbnail: '',
          location: '',
          type: 'business',
          live: null,
          needsCrawl: true
        });
      }
      return results;
    } catch (e) { return []; }
  }

  // ── Source: Bing Search Scrape ───────────────────────────────────
  async function searchBing(query, delay = 1500, jitter = 1000) {
    await sleep(delay + Math.random() * jitter);
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20`;
      const result = await Bridge.fetch(url, { 'User-Agent': randomUA() });
      if (!result.success || !result.body) return [];
      const html = result.body;
      const results = [];
      const rx = /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m, i = 0;
      while ((m = rx.exec(html)) !== null && i < 10) {
        const link = m[1], title = m[2].replace(/<[^>]+>/g, '').trim();
        if (!link.includes('bing.com') && !link.includes('microsoft.com')) {
          results.push({
            id: `bing_${Date.now()}_${i}`,
            source: 'Bing',
            title,
            url: link,
            thumbnail: '',
            location: '',
            type: 'business',
            live: null,
            needsCrawl: true
          });
          i++;
        }
      }
      return results;
    } catch (e) { return []; }
  }

  // ── Source: Traffic/DOT Cams ─────────────────────────────────────
  const TRAFFIC_FEEDS = {
    'CA': 'https://cwwp2.dot.ca.gov/data/d3/cctv/cctvStatusD03.json',
    'WA': 'https://www.wsdot.wa.gov/Traffic/api/Cameras/CameraLocation?AccessCode=wsdot',
    'OR': 'https://tripcheck.com/api/cameras',
    'TX': 'https://www.drivetexas.org/api/cameras',
  };

  async function searchTrafficCams(state) {
    const feed = TRAFFIC_FEEDS[state?.toUpperCase()];
    if (!feed) return [{
      id: `traffic_generic_${state}`,
      source: 'Traffic/DOT',
      title: `${state} 511 Traffic Cameras`,
      url: `https://511.org/open-data/traffic`,
      thumbnail: '',
      location: state,
      type: 'traffic',
      live: true
    }];
    try {
      const result = await Bridge.fetch(feed, {}, false);
      if (!result.success) return [];
      return [{
        id: `traffic_${state}`,
        source: 'Traffic/DOT',
        title: `${state} Traffic Camera Feed`,
        url: feed,
        thumbnail: '',
        location: state,
        type: 'traffic',
        live: true
      }];
    } catch (e) { return []; }
  }

  // ── Deep crawl a site for webcam embeds ─────────────────────────
  async function crawlSite(url) {
    try {
      const result = await Bridge.fetch(url, { 'User-Agent': randomUA() }, true);
      if (!result.success || !result.body) return { found: false };
      const html = result.body;
      const checks = [
        { rx: /mjpg|mjpeg|video\.cgi/i, type: 'MJPEG Stream' },
        { rx: /\.m3u8/i, type: 'HLS Stream' },
        { rx: /youtube\.com\/embed/i, type: 'YouTube Live' },
        { rx: /earthcam\.com/i, type: 'EarthCam Embed' },
        { rx: /<video[^>]+src/i, type: 'HTML5 Video' },
        { rx: /webcam|live.?cam|livefeed/i, type: 'Webcam Page' },
      ];
      for (const { rx, type } of checks) {
        if (rx.test(html)) {
          const m3u8 = html.match(/https?:\/\/[^\s"']+\.m3u8/i);
          const mjpg = html.match(/https?:\/\/[^\s"']+mjp[ge]+[^\s"']*/i);
          return { found: true, type, streamUrl: m3u8?.[0] || mjpg?.[0] || url };
        }
      }
      return { found: false };
    } catch (e) { return { found: false }; }
  }

  return { resolveLocation, searchWindy, searchEarthCam, searchGoogle, searchBing, searchTrafficCams, crawlSite };
})();
