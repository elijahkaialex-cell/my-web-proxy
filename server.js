// server.js (CommonJS / Render-ready)
const express = require('express');
const fetch = require('node-fetch'); // CommonJS
const cheerio = require('cheerio');
const morgan = require('morgan');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public', { index: false }));

/**
 * Resolve a possibly-relative URL against a base.
 */
function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Simple SSRF protection (basic).
 * Blocks requests to localhost/metadata addresses.
 */
function isBlockedUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  // block common local/internal addresses
  if (lower.startsWith('http://127.') || lower.startsWith('http://localhost') ||
      lower.startsWith('http://0.0.0.0') || lower.startsWith('http://169.254.') ||
      lower.startsWith('http://[::1]') || lower.includes('169.254.169.254')) {
    return true;
  }
  return false;
}

/**
 * Fetch resource and send back to client.
 */
async function proxyFetch(rawUrl, req, res) {
  if (!rawUrl) {
    res.status(400).send('Missing url');
    return;
  }
  if (isBlockedUrl(rawUrl)) {
    res.status(400).send('Blocked URL');
    return;
  }

  try {
    const headers = {};
    // Optionally forward a subset of client headers
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    if (req.headers['accept']) headers['accept'] = req.headers['accept'];

    const resp = await fetch(rawUrl, { headers: headers, redirect: 'follow' });

    // copy certain headers
    const contentType = resp.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);

    const allowed = ['cache-control', 'content-length', 'content-type', 'last-modified', 'etag'];
    resp.headers.forEach((value, key) => {
      if (allowed.includes(key)) res.set(key, value);
    });

    const buffer = await resp.buffer();
    res.status(resp.status).send(buffer);
  } catch (err) {
    console.error('proxyFetch error', err && err.stack ? err.stack : err);
    res.status(500).send('Error fetching remote resource');
  }
}

/**
 * Serve the index page (public/index.html)
 */
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

/**
 * /search - proxies DuckDuckGo lite results and rewrites links/resources
 */
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.redirect('/');

  const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;

  try {
    const resp = await fetch(ddgUrl, { redirect: 'follow' });
    const text = await resp.text();

    const $ = cheerio.load(text);
    const baseUrl = ddgUrl;

    // Rewrite anchors
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const resolved = resolveUrl(baseUrl, href);
      if (!resolved) return;
      if (resolved.startsWith('javascript:') || resolved.startsWith('mailto:')) return;

      $(el).attr('href', `/fetch?url=${encodeURIComponent(resolved)}`);
      $(el).attr('target', '_self');
    });

    // Images
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr('src', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Stylesheets
    $("link[rel='stylesheet']").each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (!resolved) return;
      $(el).attr('href', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Scripts
    $('script').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr('src', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Forms - keep them inside the proxy
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      const method = ($(el).attr('method') || 'GET').toUpperCase();
      const resolved = action ? resolveUrl(baseUrl, action) : baseUrl;
      if (!resolved) return;
      $(el).attr('action', `/fetch?url=${encodeURIComponent(resolved)}`);
      $(el).attr('method', method);
    });

    // Optional banner
    $('body').prepend(`<div style="background:#f7f7f7;border-bottom:1px solid #ddd;padding:6px;font-size:14px;">
      Proxy: showing results for <strong>${q}</strong> — <a href="/">New search</a>
    </div>`);

    res.send($.html());
  } catch (err) {
    console.error('Error fetching DDG:', err && err.stack ? err.stack : err);
    res.status(500).send('Error fetching search results');
  }
});

/**
 * /fetch - generic proxy for any resource (GET and POST)
 */
app.all('/fetch', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Missing url');
  if (isBlockedUrl(raw)) return res.status(400).send('Blocked URL');

  if (req.method === 'GET') {
    await proxyFetch(raw, req, res);
    return;
  }

  // POST handling - forward basic form/json bodies
  if (req.method === 'POST') {
    try {
      let headers = {};
      let body = null;

      if (req.is('application/json')) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.body || {});
      } else {
        // form data
        const params = new URLSearchParams();
        for (const k of Object.keys(req.body || {})) {
          params.append(k, req.body[k]);
        }
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = params.toString();
      }

      const rr = await fetch(raw, { method: 'POST', headers, body, redirect: 'follow' });
      const contentType = rr.headers.get('content-type');
      if (contentType) res.set('Content-Type', contentType);
      const buf = await rr.buffer();
      res.status(rr.status).send(buf);
    } catch (err) {
      console.error('POST proxy error', err && err.stack ? err.stack : err);
      res.status(500).send('Error proxying POST');
    }
    return;
  }

  // fallback
  await proxyFetch(raw, req, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy app listening on port ${PORT}`);
});
