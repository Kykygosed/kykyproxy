const express = require('express');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const { URL } = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

/* URL publique de CE serveur proxy (Render) */
const PROXY_ORIGIN = process.env.PROXY_ORIGIN || 'https://kykyproxy.onrender.com';

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
   Intercepte fetch, XHR, import() dynamiques
   et le public path webpack pour les chunks
───────────────────────────────────────*/
function buildInjectedScript(targetOrigin) {
  return `
<script>
(function() {
  var PROXY   = '${PROXY_ORIGIN}/proxy?url=';
  var BASE    = '${targetOrigin}';

  function toProxy(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('blob:') ||
        url.startsWith('javascript:') || url.indexOf(PROXY) !== -1) return url;
    try {
      var abs = new URL(url, BASE).href;
      // Ne proxifie que les URLs externes (pas déjà sur le proxy)
      if (abs.indexOf('${PROXY_ORIGIN}') === 0) return url;
      return PROXY + encodeURIComponent(abs);
    } catch(e) { return url; }
  }

  /* ── fetch ── */
  var _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = toProxy(input);
    else if (input && input.url) input = new Request(toProxy(input.url), input);
    return _fetch(input, init);
  };

  /* ── XMLHttpRequest ── */
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = toProxy(url);
    return _open.apply(this, args);
  };

  /* ── WebSocket ── */
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    // WebSocket ne peut pas passer par un proxy HTTP simple, on laisse passer
    return protocols ? new _WS(url, protocols) : new _WS(url);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING  = _WS.CONNECTING;
  window.WebSocket.OPEN        = _WS.OPEN;
  window.WebSocket.CLOSING     = _WS.CLOSING;
  window.WebSocket.CLOSED      = _WS.CLOSED;

  /* ── Webpack public path (chunks Discord, YouTube, etc.) ──
     On surveille __webpack_require__.p dès qu'il est défini          */
  var _pubPath = '/';
  Object.defineProperty(window, '__webpack_public_path__', {
    get: function() { return PROXY + encodeURIComponent(BASE + '/'); },
    set: function(v) { _pubPath = v; },
    configurable: true
  });

  /* Patch générique pour tout objet qui stocke le public path webpack */
  var patchWebpack = function(obj) {
    if (!obj) return;
    ['p','publicPath'].forEach(function(key) {
      if (typeof obj[key] === 'string' && obj[key].indexOf('http') === 0) {
        obj[key] = PROXY + encodeURIComponent(obj[key]);
      }
    });
  };

  /* ── document.createElement('script') ──
     Pour les frameworks qui injectent des scripts dynamiquement         */
  var _createElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = _createElement(tag);
    if (tag.toLowerCase() === 'script') {
      var _setSrc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
      if (_setSrc) {
        Object.defineProperty(el, 'src', {
          get: function() { return _setSrc.get.call(this); },
          set: function(v) { _setSrc.set.call(this, toProxy(v)); },
          configurable: true
        });
      }
    }
    return el;
  };

  /* ── History API (navigation SPA) ── */
  var _pushState    = history.pushState.bind(history);
  var _replaceState = history.replaceState.bind(history);
  history.pushState = function(state, title, url) {
    return _pushState(state, title, url); // on laisse la SPA gérer elle-même
  };

  console.log('[KykyProxy] Intercepteurs actifs pour', BASE);
})();
</script>`;
}

/* ─────────────────────────────────────
   GET /proxy?url=<url encodée>
───────────────────────────────────────*/
app.get('/proxy', (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Paramètre ?url= manquant.');

  let target;
  try {
    target = new URL(raw);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error();
  } catch {
    return res.status(400).send('URL invalide.');
  }

  const driver = target.protocol === 'https:' ? https : http;

  const options = {
    hostname : target.hostname,
    port     : target.port || (target.protocol === 'https:' ? 443 : 80),
    path     : target.pathname + target.search,
    method   : 'GET',
    headers  : {
      'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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
      'x-frame-options',
      'content-security-policy',
      'content-security-policy-report-only',
      'strict-transport-security',
      'x-content-type-options',
      'transfer-encoding',
      'content-encoding',
      'content-length',
    ]);
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (!BLOCKED.has(k.toLowerCase())) {
        try { res.setHeader(k, v); } catch {}
      }
    });
    res.status(proxyRes.statusCode);

    const encoding    = proxyRes.headers['content-encoding'];
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isHtml      = contentType.includes('text/html');
    const isJs        = contentType.includes('javascript');
    const isCss       = contentType.includes('text/css');

    /* ── Décompression ── */
    let stream = proxyRes;
    if      (encoding === 'gzip')    stream = proxyRes.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (encoding === 'br')      stream = proxyRes.pipe(zlib.createBrotliDecompress());

    function onStreamError(err) {
      console.error('[proxy] stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
    }

    /* ── Texte (HTML / JS / CSS) → buffer puis réécriture ── */
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
      stream.on('error', onStreamError);
    } else {
      /* Binaires, images, fonts → stream direct */
      stream.pipe(res);
      stream.on('error', onStreamError);
    }
  });

  proxyReq.setTimeout(20000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).send('Délai dépassé.');
  });

  proxyReq.on('error', err => {
    console.error('[proxy] erreur:', err.message);
    if (!res.headersSent) res.status(502).send('Site temporairement indisponible.');
  });

  proxyReq.end();
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
  /* href / src / action */
  html = html.replace(
    /((?:href|src|action)\s*=\s*)(['"])(.*?)\2/gi,
    (_, attr, q, val) => `${attr}${q}${toProxyUrl(val, base)}${q}`
  );

  /* srcset */
  html = html.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
    const rw = val.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return u ? [toProxyUrl(u, base), ...rest].join(' ') : part;
    }).join(', ');
    return `srcset=${q}${rw}${q}`;
  });

  /* CSS url() dans <style> */
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_, q, u) => `url(${q}${toProxyUrl(u, base)}${q})`
  );

  /* meta refresh */
  html = html.replace(/(content\s*=\s*['"][^'"]*?url=)([^'"&\s]+)/gi,
    (_, pre, u) => `${pre}${toProxyUrl(u, base)}`
  );

  /* Injection du script intercepteur juste après <head> */
  html = html.replace(/<head([^>]*)>/i,
    (m) => m + buildInjectedScript(base.origin)
  );

  return html;
}

/* ─────────────────────────────────────
   Réécriture JS — cible les URLs absolues dans les strings
   et les chemins de chunks webpack
───────────────────────────────────────*/
function rewriteJs(js, base) {
  const origin = base.origin;

  /* Strings contenant l'origine cible : "https://discord.com/..." */
  js = js.replace(
    new RegExp(`(['"\`])(https?://${escapeRegex(base.hostname)}[^'"\`]*)\\1`, 'g'),
    (_, q, url) => `${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(url)}${q}`
  );

  /* Public path webpack souvent stocké comme "https://cdn.discord.com/" ou "/" */
  js = js.replace(
    /(__webpack_require__\s*\.\s*p\s*=\s*)(['"`])(https?:\/\/[^'"`]+|\/[^'"`]*)(['"`])/g,
    (_, prefix, q, path, q2) => {
      const abs = path.startsWith('http') ? path : origin + path;
      return `${prefix}${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(abs)}${q2}`;
    }
  );

  return js;
}

/* ─────────────────────────────────────
   Réécriture CSS
───────────────────────────────────────*/
function rewriteCss(css, base) {
  /* url(...) */
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_, q, u) => `url(${q}${toProxyUrl(u, base)}${q})`
  );
  /* @import "..." */
  css = css.replace(/@import\s+(['"])(.*?)\1/gi,
    (_, q, u) => `@import ${q}${toProxyUrl(u, base)}${q}`
  );
  return css;
}

/* ─────────────────────────────────────
   Utils
───────────────────────────────────────*/
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─────────────────────────────────────
   Démarrage
───────────────────────────────────────*/
app.listen(PORT, () => {
  console.log(`KykyProxy en écoute sur le port ${PORT}`);
  console.log(`  → /proxy?url=https://example.com`);
});
