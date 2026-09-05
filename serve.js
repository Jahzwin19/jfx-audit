const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 4040;
const DEMOS_DIR = path.join(__dirname, 'demos');
const TRACKING_FILE = path.join(__dirname, 'tracking.json');
const LICENSES_FILE = path.join(__dirname, 'licenses.json');
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

if (!fs.existsSync(DEMOS_DIR)) fs.mkdirSync(DEMOS_DIR, { recursive: true });

// Load or init tracking data
function loadTracking() {
  try { return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); }
  catch(e) { return { audits: [], totalAudits: 0, uniqueUsers: 0, ips: [] }; }
}
function saveTracking(data) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Load or init license data
function loadLicenses() {
  try { return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8')); }
  catch(e) { return { keys: {} }; }
}
function saveLicenses(data) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function fetchUrl(targetUrl, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return fetchUrl(resp.headers.location, timeout).then(resolve).catch(reject);
      }
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

http.createServer(async (req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);

  // POST /track — record an audit usage
  if (req.method === 'POST' && parsed.pathname === '/track') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const tracking = loadTracking();
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const entry = {
        timestamp: new Date().toISOString(),
        ip,
        city: data.city || '',
        country: data.country || '',
        bizName: data.bizName || '',
        industry: data.industry || '',
        websiteUrl: data.websiteUrl || '',
        userAgent: req.headers['user-agent'] || ''
      };
      tracking.audits.push(entry);
      tracking.totalAudits = tracking.audits.length;
      if (!tracking.ips.includes(ip)) {
        tracking.ips.push(ip);
        tracking.uniqueUsers = tracking.ips.length;
      }
      // Keep only last 1000 entries
      if (tracking.audits.length > 1000) tracking.audits = tracking.audits.slice(-1000);
      if (tracking.ips.length > 5000) tracking.ips = tracking.ips.slice(-5000);
      saveTracking(tracking);
      sendJSON(res, 200, { ok: true, totalAudits: tracking.totalAudits, uniqueUsers: tracking.uniqueUsers });
    } catch(e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /stats — view usage stats (admin)
  if (req.method === 'GET' && parsed.pathname === '/stats') {
    const tracking = loadTracking();
    const recent = tracking.audits.slice(-20).reverse();
    const industries = {};
    tracking.audits.forEach(a => { if (a.industry) industries[a.industry] = (industries[a.industry] || 0) + 1; });
    sendJSON(res, 200, {
      totalAudits: tracking.totalAudits,
      uniqueUsers: tracking.uniqueUsers,
      recentAudits: recent,
      topIndustries: Object.entries(industries).sort((a,b) => b[1] - a[1]).slice(0, 10)
    });
    return;
  }

  // POST /verify-license — verify a license key
  if (req.method === 'POST' && parsed.pathname === '/verify-license') {
    try {
      const body = await readBody(req);
      const { key, domain } = JSON.parse(body);
      const licenses = loadLicenses();
      const license = licenses.keys[key];
      if (!license) {
        sendJSON(res, 200, { valid: false, error: 'Invalid license key' });
        return;
      }
      if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
        sendJSON(res, 200, { valid: false, error: 'License expired' });
        return;
      }
      if (license.domains && license.domains.length > 0 && domain && !license.domains.includes(domain)) {
        sendJSON(res, 200, { valid: false, error: 'Domain not authorized' });
        return;
      }
      sendJSON(res, 200, { valid: true, plan: license.plan || 'pro', expiresAt: license.expiresAt });
    } catch(e) {
      sendJSON(res, 400, { valid: false, error: e.message });
    }
    return;
  }

  // POST /create-license — create a new license key (admin)
  if (req.method === 'POST' && parsed.pathname === '/create-license') {
    try {
      const body = await readBody(req);
      const { plan, domains, expiresInDays } = JSON.parse(body);
      const key = 'JFX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      const licenses = loadLicenses();
      licenses.keys[key] = {
        plan: plan || 'pro',
        domains: domains || [],
        createdAt: new Date().toISOString(),
        expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null
      };
      saveLicenses(licenses);
      sendJSON(res, 200, { ok: true, key, expiresAt: licenses.keys[key].expiresAt });
    } catch(e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // POST /save-demo
  if (req.method === 'POST' && parsed.pathname === '/save-demo') {
    try {
      const body = await readBody(req);
      const { filename, html } = JSON.parse(body);
      const safeName = filename.replace(/[^a-z0-9\-\.]/gi, '-').toLowerCase();
      const filePath = path.join(DEMOS_DIR, safeName);
      fs.writeFileSync(filePath, html, 'utf8');
      sendJSON(res, 200, { ok: true, path: `/demos/${safeName}` });
    } catch(e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /proxy?url=...  — fetch any URL server-side, bypassing CORS
  if (parsed.pathname === '/proxy' && parsed.query.url) {
    try {
      const targetUrl = decodeURIComponent(parsed.query.url);
      const html = await fetchUrl(targetUrl);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch(e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // GET /search?q=...&engine=google|bing|duckduckgo  — server-side search
  if (parsed.pathname === '/search' && parsed.query.q) {
    const query = decodeURIComponent(parsed.query.q);
    const engine = parsed.query.engine || 'bing';
    try {
      let searchUrl;
      if (engine === 'google') {
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=ng&num=10`;
      } else if (engine === 'duckduckgo') {
        searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=ng-en`;
      } else {
        searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=en&cc=NG&mkt=en-NG`;
      }
      const html = await fetchUrl(searchUrl);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch(e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // Serve static files
  let urlPath = parsed.pathname;
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else { res.writeHead(200, { 'Content-Type': contentType }); res.end(content); }
  });
}).listen(PORT, () => {
  console.log(`JFX Audit Tool running at http://localhost:${PORT}`);
});
