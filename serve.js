const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 4040;
const DEMOS_DIR = path.join(__dirname, 'demos');
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
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=10`;
      } else if (engine === 'duckduckgo') {
        searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      } else {
        searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`;
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
