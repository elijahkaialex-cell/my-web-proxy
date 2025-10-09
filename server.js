// server.js - Fixed version with security improvements and bug fixes
const express = require('express');
const cheerio = require('cheerio');
const morgan = require('morgan');
const { URL } = require('url');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS) || 15000;
const MAX_REDIRECTS = 5;

// Middleware
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public', { index: false }));

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

/**
 * Resolves a relative URL against a base URL
 * @param {string} base - Base URL
 * @param {string} href - URL to resolve
 * @returns {string|null} Resolved URL or null if invalid
 */
function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Enhanced SSRF protection - blocks private IPs and localhost
 * @param {string} url - URL to check
 * @returns {boolean} True if URL should be blocked
 */
function isBlockedUrl(url) {
  if (!url) return true;
  
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    return true;
  }

  // Block non-HTTP protocols
  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    return true;
  }

  const hostname = urlObj.hostname.toLowerCase();
  
  // Block private IP ranges
  const privatePatterns = [
    /^127\./,           // Loopback
    /^10\./,            // Private Class A
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
    /^192\.168\./,     // Private Class C
    /^169\.254\./,     // Link-local
    /^::1$/,            // IPv6 loopback
    /^fc00:/,           // IPv6 private
    /^fe80:/            // IPv6 link-local
  ];

  // Block localhost variants and cloud metadata endpoints
  const blockedHosts = [
    'localhost',
    '0.0.0.0',
    'metadata.google.internal',
    '169.254.169.254'
  ];

  if (blockedHosts.includes(hostname)) {
    return true;
  }

  for (const pattern of privatePatterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  return false;
}

/**
 * Native HTTP/HTTPS fetch with redirect following
 * @param {string} urlString - URL to fetch
 * @param {Object} options - Request options (method, headers, body, timeoutMs)
 * @param {number} maxRedirects - Maximum number of redirects to follow
 * @returns {Promise<{statusCode: number, headers: Object, body: Buffer}>}
 */
function nativeFetch(urlString, options = {}, maxRedirects = MAX_REDIRECTS) {
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

      // Follow redirects
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
        req.destroy(); // Fixed: use destroy() instead of abort()
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

/**
 * Proxy GET requests for resources
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
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    if (req.headers['accept']) headers['accept'] = req.headers['accept'];

    const resp = await nativeFetch(rawUrl, { method: 'GET', headers: headers, timeoutMs: TIMEOUT_MS }, MAX_REDIRECTS);

    if (resp.headers['content-type']) res.set('Content-Type', resp.headers['content-type']);
    const allowed = ['cache-control', 'content-length', 'content-type', 'last-modified', 'etag'];
    for (const k of Object.keys(resp.headers || {})) {
      if (allowed.includes(k)) res.set(k, resp.headers[k]);
    }

    res.status(resp.statusCode || 200).send(resp.body);
  } catch (err) {
    console.error('proxyFetch error:', err.message);
    res.status(500).send('Error fetching remote resource');
  }
}

/* Routes */

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Homepage
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Search route - handle both GET and POST for captcha forms
app.all('/search', async (req, res) => {
  // Get query from either GET or POST
  const q = req.query.q || req.body.q;
  if (!q) return res.redirect('/');

  // Build DDG URL with all query params
  const params = new URLSearchParams();
  const allParams = { ...req.query, ...req.body };
  for (const [key, value] of Object.entries(allParams)) {
    params.append(key, value);
  }

  const ddgUrl = `https://lite.duckduckgo.com/lite/?${params.toString()}`;

  try {
    const fetchOptions = {
      method: req.method,
      headers: { 'user-agent': req.headers['user-agent'] || 'node-proxy' },
      timeoutMs: TIMEOUT_MS
    };

    // If POST, include the body
    if (req.method === 'POST') {
      fetchOptions.body = req.body;
    }

    const fetched = await nativeFetch(ddgUrl, fetchOptions, MAX_REDIRECTS);
    
    const text = fetched.body.toString('utf8');
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

    // Rewrite images
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr('src', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Rewrite stylesheets
    $("link[rel='stylesheet']").each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (!resolved) return;
      $(el).attr('href', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Rewrite scripts
    $('script').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr('src', `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Rewrite forms - keep them pointing through /search for proper handling
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      const method = ($(el).attr('method') || 'GET').toUpperCase();
      
      // If it's a search form going to DDG, redirect to our /search endpoint
      if (action.includes('duckduckgo.com') || action.includes('/lite/')) {
        $(el).attr('action', '/search');
        $(el).attr('method', 'GET');
      } else if (action) {
        const resolved = resolveUrl(baseUrl, action);
        if (!resolved) return;
        $(el).attr('action', `/fetch?url=${encodeURIComponent(resolved)}`);
        $(el).attr('method', method);
      }
    });

    // Add proxy banner
    $('body').prepend(`<div style="background:#f7f7f7;border-bottom:1px solid #ddd;padding:6px;font-size:14px;">
      Proxy: showing results for <strong>${cheerio.load('<div></div>').text(q)}</strong> — <a href="/">New search</a>
    </div>`);

    res.send($.html());
  } catch (err) {
    console.error('Error fetching DDG:', err.message);
    res.status(500).send('Error fetching search results');
  }
});

// Fetch proxy route
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

      const rr = await nativeFetch(raw, { method: 'POST', headers, body, timeoutMs: TIMEOUT_MS }, MAX_REDIRECTS);
      if (rr.headers['content-type']) res.set('Content-Type', rr.headers['content-type']);
      res.status(rr.statusCode || 200).send(rr.body);
    } catch (err) {
      console.error('POST proxy error:', err.message);
      res.status(500).send('Error proxying POST');
    }
    return;
  }

  // Fallback for other methods
  await proxyFetch(raw, req, res);
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Not found');
});

/* Start server */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy app listening on port ${PORT}`);
  console.log(`Node version: ${process.version}`);
});
