// server.js
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const morgan = require("morgan");
const { URL } = require("url");


const app = express();
const PORT = process.env.PORT || 10000; // Render forwards to the port you bind to

app.use(morgan("tiny"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public", { index: false }));

/**
 * Helper: safe absolute URL resolution
 * base: string (the URL of the HTML page)
 * href: string (the link or resource value)
 */
function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Fetch resource and send back. We stream the buffer and set content-type.
 * We also remove hop-by-hop headers that shouldn't be forwarded.
 */
async function proxyFetch(rawUrl, req, res) {
  if (!rawUrl) {
    res.status(400).send("Missing url");
    return;
  }

  // Prevent simple SSRF to localhost by accident. (You can adjust these checks.)
  if (rawUrl.startsWith("http://127.") || rawUrl.startsWith("http://localhost") || rawUrl.startsWith("http://0.0.0.0")) {
    res.status(400).send("Blocked URL");
    return;
  }

  try {
    const headers = {};
    // forward some client headers (optional)
    if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
    // request remote resource
    const resp = await fetch(rawUrl, { headers, redirect: "follow" });

    // copy content-type
    const contentType = resp.headers.get("content-type");
    if (contentType) res.set("Content-Type", contentType);

    // copy cache-control, content-length, etc (but filter hop-by-hop)
    const allowed = ["cache-control", "content-length", "content-type", "last-modified", "etag"];
    for (const [k, v] of resp.headers.entries()) {
      if (allowed.includes(k)) res.set(k, v);
    }

    // stream buffer
    const buffer = await resp.arrayBuffer();
    res.status(resp.status).send(Buffer.from(buffer));
  } catch (err) {
    console.error("proxyFetch error", err);
    res.status(500).send("Error fetching remote resource");
  }
}

/**
 * Public search page: form submits to /search?q=...
 * We also have separate static file public/index.html served from / (express.static)
 */

// Search route: forward the query to DuckDuckGo lite and rewrite links/resources
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.redirect("/");

  // DuckDuckGo lite endpoint (simpler HTML)
  const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;

  try {
    const resp = await fetch(ddgUrl, { redirect: "follow" });
    const text = await resp.text();

    // Use cheerio to parse and rewrite links/resources
    const $ = cheerio.load(text);

    const baseUrl = ddgUrl;

    // Rewrite all anchors to route through /fetch
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Resolve absolute URL relative to the page
      const resolved = resolveUrl(baseUrl, href);
      if (!resolved) return;

      // Keep anchors that are javascript: or mailto:
      if (resolved.startsWith("javascript:") || resolved.startsWith("mailto:")) return;

      // Replace with proxy route
      const proxied = `/fetch?url=${encodeURIComponent(resolved)}`;
      $(el).attr("href", proxied);
      // Optional: ensure links open in same tab (no target)
      $(el).attr("target", "_self");
    });

    // Rewrite images
    $("img").each((i, el) => {
      const src = $(el).attr("src");
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr("src", `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Rewrite links to stylesheets
    $("link[rel='stylesheet']").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (!resolved) return;
      $(el).attr("href", `/fetch?url=${encodeURIComponent(resolved)}`);
    });

    // Rewrite script src
    $("script").each((i, el) => {
      const src = $(el).attr("src");
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (!resolved) return;
      $(el).attr("src", `/fetch?url=${encodeURIComponent(resolved)}`);
      // If you don't want remote JS to execute, you could remove the src attribute or
      // replace script tags with non-executable placeholders. For now we proxy.
    });

    // Rewrite forms action to keep queries in proxy scope
    $("form").each((i, el) => {
      const action = $(el).attr("action") || "";
      const method = ($(el).attr("method") || "GET").toUpperCase();
      const resolved = action ? resolveUrl(baseUrl, action) : baseUrl;
      if (!resolved) return;
      // Set action to our proxy /fetch which will forward the method and body
      $(el).attr("action", `/fetch?url=${encodeURIComponent(resolved)}`);
      // Keep method same (proxy will forward GET/POST)
      $(el).attr("method", method);
    });

    // Inject a small banner so users know they're inside your proxy (optional)
    $("body").prepend(`<div style="background:#f7f7f7;border-bottom:1px solid #ddd;padding:6px;font-size:14px;">
      Proxy: showing results for <strong>${q}</strong> — <a href="/">New search</a>
    </div>`);

    res.send($.html());
  } catch (err) {
    console.error("Error fetching DDG:", err);
    res.status(500).send("Error fetching search results");
  }
});

/**
 * Generic fetch route: fetch any URL and return it.
 * Supports GET and POST (for proxied forms).
 */
app.all("/fetch", async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send("Missing url");

  // For GET, just proxy
  if (req.method === "GET") {
    await proxyFetch(raw, req, res);
    return;
  }

  // For POST: forward the body as application/x-www-form-urlencoded by default
  if (req.method === "POST") {
    // Build a form body
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    // If JSON was posted, forward it
    let body = null;
    if (req.is("application/json")) {
      body = JSON.stringify(req.body);
      headers["content-type"] = "application/json";
    } else {
      // form data => encode
      const params = new URLSearchParams();
      for (const k of Object.keys(req.body || {})) {
        params.append(k, req.body[k]);
      }
      body = params.toString();
    }

    try {
      const rr = await fetch(raw, { method: "POST", headers, body, redirect: "follow" });
      const contentType = rr.headers.get("content-type");
      if (contentType) res.set("Content-Type", contentType);
      const buf = await rr.arrayBuffer();
      res.status(rr.status).send(Buffer.from(buf));
    } catch (err) {
      console.error("POST proxy error", err);
      res.status(500).send("Error proxying POST");
    }
    return;
  }

  // Other methods: simple forward as GET fallback
  await proxyFetch(raw, req, res);
});

app.get("/", (req, res) => {
  // serve public/index.html (express.static will serve it),
  // but fallback to sending file explicitly
  res.sendFile("index.html", { root: "public" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy app listening on port ${PORT}`);
});
