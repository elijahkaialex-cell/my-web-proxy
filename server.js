// server.js - native http/https fetch, CommonJS, Render-ready
const express = require('express');
const cheerio = require('cheerio');
const morgan = require('morgan');
const { URL } = require('url');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public', { index: false }));

function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

function isBlockedUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (
    lower.startsWith('http://127.') ||
    lower.startsWith('http://localhost') ||
    lower.startsWith('http://0.0.0.0') ||
    lower.includes('169.254.169.254') ||
    lower.startsWith('http://169.254.') ||
    lower.startsWith('http://[::1]')
  ) {
    return true;
  }
  return false;
}

/**
 * nativeFetch: uses http/https and follows redirects (maxRedirects)
 * returns { statusCode, headers, body } where body is a Buffer
 */
function nativeFetch(urlString, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));
    let urlObj;
    try {
      urlObj = new URL(urlString);
    } catch (e) {
      return reject(new Error('Invalid URL'));
    }

    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: options.method || 'GET',
      headers: Object.assign({}, options.headers || {})
    };

    reqOptions.headers['connection'] = 'close';

    const req = lib.request(reqOptions, (res) => {
      const statusCode = res.statusCode || 0;
      const headers = res.headers || {};

      // follow redirects
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        const nextUrl = resolveUrl(urlString, headers.location);
        const nextMethod = (statusCode === 303) ? 'GET' : reqOptions.method;
        res.resume();
        return resolve(nativeFetch(nextUrl, { method: nextMethod, headers: options.headers }, maxRedirects - 1));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ statusCode, headers, body });
      });
    });

    req.on('error', (err) => reject(err));
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.abort();
        reject(new Error('Request timed out'));
      });
    }

    if (options.body && reqOptions.method !== 'GET' && reqOptions.method !== 'HEAD') {
      if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
        req.write(options.body);
      } else if (typeof options.body === 'object') {
        const payload = new URLSearchParams(options.body).toString();
        req.write(payload);
      }
    }

    req.end();
  });
}

/* proxyFetch - used for GET proxying of resources */
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
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    if (req.headers['accept']) headers['accept'] = req.headers['accept'];

    const resp = await nativeFetch(rawUrl, { method: 'GET', headers: headers, timeoutMs: 20000 }, 5);

    if (resp.headers['content-type']) res.set('Content-Type', resp.headers['content-type']);
    const allowed = ['cache-control', 'content-length', 'content-type', 'last-modified', 'etag'];
    for (const k of Object.keys(resp.headers || {})) {
      if (allowed.includes(k)) res.set(k, resp.headers[k]);
    }

    res.status(resp.statusCode || 200).send(resp.body);
  } catch (err) {
    console.error('proxyFetch error', err && err.stack ? err.stack : err);
    res.status(500).send('Error fetching remote resource');
  }
}

/* Routes */
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.redirect('/');

  const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;

  try {
    const fetched = await nativeFetch(ddgUrl, { method: 'GET', headers: { 'user-agent': req.headers['user-agent'] || 'node-proxy' } }, 5);
    const text = fetched.body.toString('utf8');

    const $ = cheerio.load(text);
    const baseUrl = ddgUrl;

    // anchors
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (!resolved) return;
      if (resolved.startsWith('javascript:') || resolved.startsWith('mailto:')) return;
      $(el).attr('href', `/fetch?url=${encodeURIComponent(resolved)}`);
      $(el).attr('target', '_self');
    });

    // images
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr('src', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // stylesheets
    $("link[rel='stylesheet']").each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (!resolved) return;
      $(el).attr('href', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // scripts
    $('script').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr('src', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // forms
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      const method = ($(el).attr('method') || 'GET').toUpperCase();
      const resolved = action ? resolveUrl(baseUrl, action) : baseUrl;
      if (!resolved) return;
      $(el).attr('action', `/fetch?url=${encodeURIComponent(resolved)}`);
      $(el).attr('method', method);
    });

    $('body').prepend(`<div style="background:#f7f7f7;border-bottom:1px solid #ddd;padding:6px;font-size:14px;">
      Proxy: showing results for <strong>${q}</strong> — <a href="/">New search</a>
    </div>`);

    res.send($.html());
  } catch (err) {
    console.error('Error fetching DDG:', err && err.stack ? err.stack : err);
    res.status(500).send('Error fetching search results');
  }
});

app.all('/fetch', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Missing url');
  if (isBlockedUrl(raw)) return res.status(400).send('Blocked URL');

  if (req.method === 'GET') {
    await proxyFetch(raw, req, res);
    return;
  }

  if (req.method === 'POST') {
    try {
      const headers = {};
      let body = null;

      if (req.is('application/json')) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.body || {});
      } else {
        const params = new URLSearchParams();
        for (const k of Object.keys(req.body || {})) {
          params.append(k, req.body[k]);
        }
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = params.toString();
      }

      const rr = await nativeFetch(raw, { method: 'POST', headers, body, timeoutMs: 20000 }, 5);
      if (rr.headers['content-type']) res.set('Content-Type', rr.headers['content-type']);
      res.status(rr.statusCode || 200).send(rr.body);
    } catch (err) {
      console.error('POST proxy error', err && err.stack ? err.stack : err);
      res.status(500).send('Error proxying POST');
    }
    return;
  }

  await proxyFetch(raw, req, res);
});

/* Start */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy app listening on port ${PORT}`);
});
