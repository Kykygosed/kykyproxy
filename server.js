const express = require('express');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const { URL } = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────
   CORS — autorise les appels depuis Netlify
───────────────────────────────────────*/
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

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

    /* ── Redirections → on les passe par le proxy aussi ── */
    const location = proxyRes.headers['location'];
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && location) {
      try {
        const redirected = new URL(location, target).toString();
        return res.redirect(302, '/proxy?url=' + encodeURIComponent(redirected));
      } catch {
        return res.status(502).send('Redirection invalide.');
      }
    }

    /* ── Copie des headers en supprimant ceux qui bloqueraient ── */
    const BLOCKED = new Set([
      'x-frame-options',
      'content-security-policy',
      'content-security-policy-report-only',
      'strict-transport-security',
      'x-content-type-options',
      'transfer-encoding',
      'content-encoding',   // on retire car on décompresse nous-mêmes
      'content-length',     // la taille change après réécriture HTML
    ]);

    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (!BLOCKED.has(k.toLowerCase())) {
        try { res.setHeader(k, v); } catch {}
      }
    });
    res.status(proxyRes.statusCode);

    /* ── Décompression ── */
    const encoding    = proxyRes.headers['content-encoding'];
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isHtml      = contentType.includes('text/html');

    let stream = proxyRes;
    if      (encoding === 'gzip')    stream = proxyRes.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (encoding === 'br')      stream = proxyRes.pipe(zlib.createBrotliDecompress());

    /* ── HTML : réécriture des liens ── */
    if (isHtml) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf-8');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(rewriteHtml(html, target));
      });
      stream.on('error', onStreamError);
    } else {
      /* Binaires, images, CSS, JS → stream direct */
      stream.pipe(res);
      stream.on('error', onStreamError);
    }
  });

  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).send('Délai dépassé.');
  });

  proxyReq.on('error', err => {
    console.error('[proxy] erreur:', err.message);
    if (!res.headersSent) res.status(502).send('Site temporairement indisponible.');
  });

  proxyReq.end();

  function onStreamError(err) {
    console.error('[proxy] stream error:', err.message);
    if (!res.headersSent) res.status(502).end();
  }
});

/* ─────────────────────────────────────
   Réécriture HTML
───────────────────────────────────────*/
const SKIP_PROTO = /^(data:|javascript:|mailto:|tel:|#|blob:|about:)/i;

function toProxyUrl(rawUrl, base) {
  try {
    if (SKIP_PROTO.test(rawUrl.trim())) return rawUrl;
    const abs = new URL(rawUrl.trim(), base).toString();
    return '/proxy?url=' + encodeURIComponent(abs);
  } catch {
    return rawUrl;
  }
}

function rewriteHtml(html, base) {
  /* href / src / action */
  html = html.replace(
    /((?:href|src|action)\s*=\s*)(['"])(.*?)\2/gi,
    (_, attr, q, val) => `${attr}${q}${toProxyUrl(val, base)}${q}`
  );

  /* srcset="img.png 1x, img@2x.png 2x" */
  html = html.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
    const rewritten = val.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      if (!u) return part;
      return [toProxyUrl(u, base), ...rest].join(' ');
    }).join(', ');
    return `srcset=${q}${rewritten}${q}`;
  });

  /* CSS url() dans les balises <style> */
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_, q, u) =>
    `url(${q}${toProxyUrl(u, base)}${q})`
  );

  /* meta refresh */
  html = html.replace(
    /(content\s*=\s*['"][^'"]*?url=)([^'"&\s]+)/gi,
    (_, pre, u) => `${pre}${toProxyUrl(u, base)}`
  );

  return html;
}

/* ─────────────────────────────────────
   Démarrage
───────────────────────────────────────*/
app.listen(PORT, () => {
  console.log(`KykyProxy en écoute sur le port ${PORT}`);
  console.log(`  → /proxy?url=https://example.com`);
});
