const express = require('express');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const { URL } = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

/* URL publique de CE serveur sur Render */
const PROXY_ORIGIN = (process.env.PROXY_ORIGIN || 'https://kykyproxy.onrender.com').replace(/\/$/, '');

/* ─────────────────────────────────────
   CORS
───────────────────────────────────────*/
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ─────────────────────────────────────
   Script injecté dans chaque page HTML
───────────────────────────────────────*/
function buildInjectedScript(targetOrigin) {
  return `<script data-kyky="1">
(function() {
  var PROXY_ORIGIN = '${PROXY_ORIGIN}';
  var TARGET       = '${targetOrigin}';
  var PROXY_BASE   = PROXY_ORIGIN + '/proxy?url=';

  /* ── Convertit n'importe quelle URL en URL proxy ── */
  function wrap(url) {
    if (!url || typeof url !== 'string') return url;
    var u = url.trim();
    if (!u || u === '#' || u.startsWith('data:') || u.startsWith('blob:') ||
        u.startsWith('javascript:') || u.startsWith('mailto:') ||
        u.indexOf(PROXY_ORIGIN) === 0) return url;
    try {
      /* URL relative → absolue par rapport à la cible */
      var abs = new URL(u, TARGET).href;
      if (abs.indexOf(PROXY_ORIGIN) === 0) return url;
      return PROXY_BASE + encodeURIComponent(abs);
    } catch(e) { return url; }
  }

  /* ── fetch ── */
  var _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = wrap(input);
    else if (input instanceof Request) input = new Request(wrap(input.url), input);
    return _fetch(input, init);
  };

  /* ── XMLHttpRequest ── */
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    var args = Array.prototype.slice.call(arguments);
    if (typeof args[1] === 'string') args[1] = wrap(args[1]);
    return _open.apply(this, args);
  };

  /* ── history.pushState / replaceState ──
     YouTube/SPA font des navigations relatives : /results?q=...
     On les réécrit pour rester dans le proxy                     */
  function wrapHistoryMethod(method) {
    var orig = history[method].bind(history);
    history[method] = function(state, title, url) {
      if (url) {
        try {
          var abs = new URL(url, TARGET).href;
          /* URL interne au site → on met à jour TARGET et on reste dans le proxy */
          if (abs.indexOf(TARGET) === 0 || new URL(abs).hostname === new URL(TARGET).hostname) {
            TARGET = new URL(abs).origin; /* met à jour la base */
            /* On appelle la méthode native avec l'URL proxy pour que le
               bouton "retour" du navigateur et les refresh fonctionnent */
            return orig(state, title, PROXY_BASE + encodeURIComponent(abs));
          }
        } catch(e) {}
      }
      return orig(state, title, url);
    };
  }
  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');

  /* ── document.createElement (scripts dynamiques) ── */
  var _create = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = _create(tag);
    var tagLow = (tag || '').toLowerCase();

    /* <script src> */
    if (tagLow === 'script') {
      var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
      if (srcDesc) {
        Object.defineProperty(el, 'src', {
          get: function() { return srcDesc.get.call(this); },
          set: function(v) { srcDesc.set.call(this, wrap(v)); },
          configurable: true
        });
      }
    }

    /* <img src> et <img srcset> — YouTube charge ses images via JS */
    if (tagLow === 'img') {
      var imgSrcDesc    = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      var imgSrcsetDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
      if (imgSrcDesc) {
        Object.defineProperty(el, 'src', {
          get: function() { return imgSrcDesc.get.call(this); },
          set: function(v) { imgSrcDesc.set.call(this, wrap(v)); },
          configurable: true
        });
      }
      if (imgSrcsetDesc) {
        Object.defineProperty(el, 'srcset', {
          get: function() { return imgSrcsetDesc.get.call(this); },
          set: function(v) {
            var rw = v.split(',').map(function(p) {
              var parts = p.trim().split(/\\s+/);
              if (parts[0]) parts[0] = wrap(parts[0]);
              return parts.join(' ');
            }).join(', ');
            imgSrcsetDesc.set.call(this, rw);
          },
          configurable: true
        });
      }
    }
    return el;
  };

  /* ── Patch global img.src sur les images déjà dans le DOM ──
     MutationObserver pour attraper les images injectées après le chargement */
  function patchImg(img) {
    var proto = HTMLImageElement.prototype;
    var srcDesc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!img._kykyPatched && srcDesc) {
      img._kykyPatched = true;
      Object.defineProperty(img, 'src', {
        get: function() { return srcDesc.get.call(this); },
        set: function(v) { srcDesc.set.call(this, wrap(v)); },
        configurable: true
      });
    }
  }
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IMG') patchImg(node);
        node.querySelectorAll && node.querySelectorAll('img').forEach(patchImg);
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /* ── Webpack public path ── */
  var _p = '';
  try {
    Object.defineProperty(window, '__webpack_public_path__', {
      get: function() { return PROXY_BASE + encodeURIComponent(TARGET + '/'); },
      set: function(v) { _p = v; },
      configurable: true
    });
  } catch(e) {}

  console.log('[KykyProxy] actif →', TARGET);
})();
</script>`;
}

/* ─────────────────────────────────────
   Fonction proxy centrale
───────────────────────────────────────*/
function fetchAndProxy(targetUrl, req, res) {
  let target;
  try {
    target = new URL(targetUrl);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error();
  } catch {
    return res.status(400).send('URL invalide : ' + targetUrl);
  }

  const driver = target.protocol === 'https:' ? https : http;

  const options = {
    hostname : target.hostname,
    port     : target.port || (target.protocol === 'https:' ? 443 : 80),
    path     : target.pathname + target.search,
    method   : 'GET',
    headers  : {
      'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept'          : req.headers['accept'] || 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language' : 'fr,en;q=0.9',
      'Accept-Encoding' : 'gzip, deflate',
      'Host'            : target.hostname,
      'Referer'         : target.origin,
    },
  };

  const proxyReq = driver.request(options, (proxyRes) => {

    /* ── Redirections ── */
    const location = proxyRes.headers['location'];
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && location) {
      try {
        const redirected = new URL(location, target).toString();
        return res.redirect(302, '/proxy?url=' + encodeURIComponent(redirected));
      } catch {
        return res.status(502).send('Redirection invalide.');
      }
    }

    /* ── Headers ── */
    const BLOCKED = new Set([
      'x-frame-options', 'content-security-policy',
      'content-security-policy-report-only', 'strict-transport-security',
      'x-content-type-options', 'transfer-encoding',
      'content-encoding', 'content-length',
    ]);
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (!BLOCKED.has(k.toLowerCase())) { try { res.setHeader(k, v); } catch {} }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(proxyRes.statusCode);

    /* ── Décompression ── */
    const encoding    = proxyRes.headers['content-encoding'] || '';
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isJs   = contentType.includes('javascript');
    const isCss  = contentType.includes('text/css');

    let stream = proxyRes;
    if      (encoding === 'gzip')    stream = proxyRes.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (encoding === 'br')      stream = proxyRes.pipe(zlib.createBrotliDecompress());

    function onError(err) {
      console.error('[proxy] stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
    }

    if (isHtml || isJs || isCss) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf-8');
        if (isHtml) {
          text = rewriteHtml(text, target);
          res.setHeader('content-type', 'text/html; charset=utf-8');
        } else if (isJs) {
          text = rewriteJs(text, target);
          res.setHeader('content-type', 'application/javascript; charset=utf-8');
        } else if (isCss) {
          text = rewriteCss(text, target);
          res.setHeader('content-type', 'text/css; charset=utf-8');
        }
        res.end(text);
      });
      stream.on('error', onError);
    } else {
      stream.pipe(res);
      stream.on('error', onError);
    }
  });

  proxyReq.setTimeout(20000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).send('Délai dépassé.');
  });
  proxyReq.on('error', err => {
    console.error('[proxy] erreur:', err.message);
    if (!res.headersSent) res.status(502).send('Site indisponible.');
  });
  proxyReq.end();
}

/* ─────────────────────────────────────
   Route principale /proxy?url=
───────────────────────────────────────*/
app.get('/proxy', (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Paramètre ?url= manquant.');
  fetchAndProxy(raw, req, res);
});

/* ─────────────────────────────────────
   Catch-all : /results?search_query=...
   Quand YouTube (ou autre SPA) fait un pushState et que
   l'utilisateur rafraîchit la page, on atterrit ici.
   On essaie de reconstruire l'URL cible depuis le Referer.
───────────────────────────────────────*/
app.use((req, res) => {
  const referer = req.headers['referer'] || '';
  let baseOrigin = null;

  /* Extraire l'origin cible depuis le Referer proxy */
  try {
    const refUrl    = new URL(referer);
    const proxied   = refUrl.searchParams.get('url');
    if (proxied) {
      baseOrigin = new URL(proxied).origin;
    }
  } catch {}

  if (baseOrigin) {
    const targetUrl = baseOrigin + req.path + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
    return fetchAndProxy(targetUrl, req, res);
  }

  /* Pas de Referer exploitable → page d'erreur utile */
  res.status(404).send(`
    <html><head><title>KykyProxy</title></head>
    <body style="font-family:sans-serif;padding:2rem;background:#070d1f;color:#e4ecff">
      <h2>Page non trouvée</h2>
      <p>Chemin demandé : <code>${req.path}</code></p>
      <p>Pour naviguer via le proxy, utilise :<br>
      <code>${PROXY_ORIGIN}/proxy?url=https://ton-site.com</code></p>
    </body></html>
  `);
});

/* ─────────────────────────────────────
   Réécriture HTML
───────────────────────────────────────*/
const SKIP = /^(data:|javascript:|mailto:|tel:|#|blob:|about:)/i;

function toProxyUrl(raw, base) {
  try {
    if (!raw || SKIP.test(raw.trim())) return raw;
    const abs = new URL(raw.trim(), base).toString();
    if (abs.startsWith(PROXY_ORIGIN)) return raw;
    return PROXY_ORIGIN + '/proxy?url=' + encodeURIComponent(abs);
  } catch { return raw; }
}

function rewriteHtml(html, base) {
  html = html.replace(/((?:href|src|action)\s*=\s*)(['"])(.*?)\2/gi,
    (_, a, q, v) => `${a}${q}${toProxyUrl(v, base)}${q}`);

  html = html.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
    const rw = val.split(',').map(p => {
      const [u, ...r] = p.trim().split(/\s+/);
      return u ? [toProxyUrl(u, base), ...r].join(' ') : p;
    }).join(', ');
    return `srcset=${q}${rw}${q}`;
  });

  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_, q, u) => `url(${q}${toProxyUrl(u, base)}${q})`);

  html = html.replace(/(content\s*=\s*['"][^'"]*?url=)([^'"&\s]+)/gi,
    (_, pre, u) => `${pre}${toProxyUrl(u, base)}`);

  /* Injection du script intercepteur */
  html = html.replace(/<head([^>]*)>/i, m => m + buildInjectedScript(base.origin));

  return html;
}

/* ─────────────────────────────────────
   Réécriture JS
───────────────────────────────────────*/
function rewriteJs(js, base) {
  /* URLs absolues de l'origin cible dans les strings */
  js = js.replace(
    new RegExp(`(['"\`])(https?://${escRx(base.hostname)}[^'"\`\\\\]*)\\1`, 'g'),
    (_, q, url) => `${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(url)}${q}`
  );

  /* __webpack_require__.p = "..." */
  js = js.replace(
    /(__webpack_require__\s*\.\s*p\s*=\s*)(['"`])(https?:\/\/[^'"`]+|\/[^'"`]*)(['"`])/g,
    (_, pre, q, path, q2) => {
      const abs = path.startsWith('http') ? path : base.origin + path;
      return `${pre}${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(abs)}${q2}`;
    }
  );

  return js;
}

/* ─────────────────────────────────────
   Réécriture CSS
───────────────────────────────────────*/
function rewriteCss(css, base) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_, q, u) => `url(${q}${toProxyUrl(u, base)}${q})`);
  css = css.replace(/@import\s+(['"])(.*?)\1/gi,
    (_, q, u) => `@import ${q}${toProxyUrl(u, base)}${q}`);
  return css;
}

function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ─────────────────────────────────────
   Démarrage
───────────────────────────────────────*/
app.listen(PORT, () => {
  console.log(`KykyProxy en écoute sur le port ${PORT}`);
  console.log(`  → /proxy?url=https://example.com`);
});
