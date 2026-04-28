const express      = require('express');
const https        = require('https');
const http         = require('http');
const zlib         = require('zlib');
const { URL }      = require('url');
/* Parse cookies sans dépendance externe */
function parseCookies(req) {
  const raw = req.headers['cookie'] || '';
  return Object.fromEntries(raw.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, decodeURIComponent(v.join('='))];
  }).filter(([k]) => k));
}

const app  = express();
const PORT = process.env.PORT || 3000;
const PROXY_ORIGIN   = (process.env.PROXY_ORIGIN  || 'https://kykyproxy.onrender.com').replace(/\/$/, '');
const FRONTEND_URL   = (process.env.FRONTEND_URL  || 'https://kykysearch.netlify.app');

/* ─────────────────────────────────────
   Middlewares
───────────────────────────────────────*/
app.use((req, res, next) => {
  req.cookies = parseCookies(req);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ─────────────────────────────────────
   Page d'accueil → redirige vers le frontend Netlify
───────────────────────────────────────*/
app.get('/', (req, res) => {
  res.redirect(302, FRONTEND_URL);
});

/* ─────────────────────────────────────
   Toggle on/off via cookie
   GET /kyky-toggle → inverse l'état et redirige
───────────────────────────────────────*/
app.get('/kyky-toggle', (req, res) => {
  const current = req.cookies['kyky_off'] === '1';
  const next    = current ? '0' : '1';
  res.setHeader('Set-Cookie',
    `kyky_off=${next}; Path=/; Max-Age=86400; SameSite=None; Secure`
  );
  /* Redirige vers la page qui a demandé le toggle, ou le frontend */
  const back = req.headers['referer'] || FRONTEND_URL;
  if (next === '1') {
    /* Proxy OFF : on essaie de rediriger vers le vrai site */
    try {
      const refUrl  = new URL(back);
      const proxied = refUrl.searchParams.get('url');
      if (proxied) return res.redirect(302, proxied);
    } catch {}
    return res.redirect(302, FRONTEND_URL);
  }
  res.redirect(302, back);
});

/* ─────────────────────────────────────
   Headers réalistes — anti-Cloudflare / anti-bot
───────────────────────────────────────*/
function buildHeaders(target, reqHeaders) {
  return {
    'Host'                   : target.hostname,
    'User-Agent'             : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'                 : reqHeaders['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language'        : 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding'        : 'gzip, deflate, br',
    'Referer'                : target.origin + '/',
    'Origin'                 : target.origin,
    'Connection'             : 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest'         : reqHeaders['sec-fetch-dest']  || 'document',
    'Sec-Fetch-Mode'         : reqHeaders['sec-fetch-mode']  || 'navigate',
    'Sec-Fetch-Site'         : 'none',
    'Sec-Fetch-User'         : '?1',
    'Sec-CH-UA'              : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile'       : '?0',
    'Sec-CH-UA-Platform'     : '"Windows"',
    'Cache-Control'          : 'max-age=0',
    'DNT'                    : '1',
  };
}

/* ─────────────────────────────────────
   Switch UI injecté dans chaque page HTML
───────────────────────────────────────*/
function buildToggleUI(proxyOff) {
  const isOff  = proxyOff === '1';
  const label  = isOff  ? '🔴 Proxy OFF' : '🟢 Proxy ON';
  const bg     = isOff  ? '#c0392b'       : '#27ae60';
  return `
<style>
  #kyky-toggle-btn {
    position: fixed; bottom: 18px; right: 18px; z-index: 2147483647;
    background: ${bg}; color: #fff; font-family: sans-serif;
    font-size: 14px; font-weight: 700; padding: 10px 18px;
    border-radius: 50px; box-shadow: 0 4px 15px rgba(0,0,0,.35);
    cursor: pointer; border: none; display: flex; align-items: center; gap: 8px;
    transition: background .2s, transform .1s;
    text-decoration: none !important;
  }
  #kyky-toggle-btn:hover { transform: scale(1.05); filter: brightness(1.1); }
  #kyky-toggle-slider {
    width: 36px; height: 20px; background: rgba(255,255,255,.35);
    border-radius: 10px; position: relative; transition: background .2s;
  }
  #kyky-toggle-slider::after {
    content:''; position:absolute; top:3px;
    left: ${isOff ? '3px' : '17px'};
    width:14px; height:14px; background:#fff;
    border-radius:50%; transition: left .2s;
  }
</style>
<a id="kyky-toggle-btn" href="${PROXY_ORIGIN}/kyky-toggle" title="Activer/désactiver le proxy">
  <span id="kyky-toggle-slider"></span>
  ${label}
</a>`;
}

/* ─────────────────────────────────────
   Script injecté dans chaque HTML
───────────────────────────────────────*/
function buildInjectedScript(targetOrigin) {
  return `<script data-kyky="1">
(function(){
  var PO   = '${PROXY_ORIGIN}';
  var BASE = '${targetOrigin}';
  var PFX  = PO + '/proxy?url=';

  function wrap(url){
    if(!url||typeof url!=='string') return url;
    var u=url.trim();
    if(!u||u==='#'||/^(data:|blob:|javascript:|mailto:|about:)/.test(u)) return url;
    if(u.indexOf(PO)===0) return url;
    try{
      var abs=new URL(u,BASE).href;
      if(abs.indexOf(PO)===0) return url;
      return PFX+encodeURIComponent(abs);
    }catch(e){return url;}
  }

  /* fetch */
  var _fetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    if(typeof input==='string') input=wrap(input);
    else if(input instanceof Request) input=new Request(wrap(input.url),input);
    return _fetch(input,init);
  };

  /* XHR */
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    var a=[].slice.call(arguments);
    if(typeof a[1]==='string') a[1]=wrap(a[1]);
    return _open.apply(this,a);
  };

  /* history */
  function patchHistory(method){
    var orig=history[method].bind(history);
    history[method]=function(state,title,url){
      if(url){
        try{
          var abs=new URL(url,BASE).href;
          if(new URL(abs).hostname===new URL(BASE).hostname){
            BASE=new URL(abs).origin;
            document.cookie='kyky_target='+encodeURIComponent(BASE)+'; path=/; SameSite=None; Secure';
            return orig(state,title,PFX+encodeURIComponent(abs));
          }
        }catch(e){}
      }
      return orig(state,title,url);
    };
  }
  patchHistory('pushState');
  patchHistory('replaceState');

  /* createElement */
  var PROTO_MAP={
    script: [HTMLScriptElement.prototype,   ['src']],
    img:    [HTMLImageElement.prototype,    ['src','srcset']],
    link:   [HTMLLinkElement.prototype,     ['href']],
    iframe: [HTMLIFrameElement.prototype,   ['src']],
    source: [HTMLSourceElement.prototype,   ['src','srcset']],
  };
  function patchEl(el,tag){
    var entry=PROTO_MAP[(tag||'').toLowerCase()];
    if(!entry||el._kyky) return;
    el._kyky=true;
    var proto=entry[0], attrs=entry[1];
    attrs.forEach(function(attr){
      var desc=Object.getOwnPropertyDescriptor(proto,attr);
      if(!desc||!desc.set) return;
      Object.defineProperty(el,attr,{
        get:function(){return desc.get.call(this);},
        set:function(v){
          if(attr==='srcset'){
            v=v.split(',').map(function(p){
              var parts=p.trim().split(/\\s+/);
              if(parts[0]) parts[0]=wrap(parts[0]);
              return parts.join(' ');
            }).join(', ');
          } else { v=wrap(v); }
          desc.set.call(this,v);
        },
        configurable:true
      });
    });
  }
  var _create=document.createElement.bind(document);
  document.createElement=function(tag){
    var el=_create(tag); patchEl(el,tag); return el;
  };

  /* MutationObserver */
  function patchNode(node){
    if(node.nodeType!==1) return;
    var tag=(node.tagName||'').toLowerCase();
    patchEl(node,tag);
    if(node.querySelectorAll)
      node.querySelectorAll('img,link,script,iframe,source').forEach(function(c){patchEl(c,c.tagName.toLowerCase());});
  }
  new MutationObserver(function(muts){
    muts.forEach(function(m){m.addedNodes.forEach(patchNode);});
  }).observe(document.documentElement,{childList:true,subtree:true});

  /* Webpack public path */
  try{
    Object.defineProperty(window,'__webpack_public_path__',{
      get:function(){return PFX+encodeURIComponent(BASE+'/');},
      set:function(){},configurable:true
    });
  }catch(e){}

  document.cookie='kyky_target='+encodeURIComponent(BASE)+'; path=/; SameSite=None; Secure';
  console.log('[KykyProxy] actif →',BASE);
})();
</script>`;
}

/* ─────────────────────────────────────
   Fonction proxy centrale
───────────────────────────────────────*/
function fetchAndProxy(targetUrl, req, res) {
  /* Si proxy désactivé → redirect direct vers la vraie URL */
  if (req.cookies['kyky_off'] === '1') {
    return res.redirect(302, targetUrl);
  }

  let target;
  try {
    target = new URL(targetUrl);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error();
  } catch {
    return res.status(400).send('URL invalide : ' + targetUrl);
  }

  /* Cookie de contexte */
  res.setHeader('Set-Cookie', [
    `kyky_target=${encodeURIComponent(target.origin)}; Path=/; Max-Age=3600; SameSite=None; Secure`,
  ]);

  const driver  = target.protocol === 'https:' ? https : http;
  const options = {
    hostname : target.hostname,
    port     : target.port || (target.protocol === 'https:' ? 443 : 80),
    path     : target.pathname + target.search,
    method   : 'GET',
    headers  : buildHeaders(target, req.headers),
  };

  const proxyReq = driver.request(options, (proxyRes) => {

    /* Redirections */
    const loc = proxyRes.headers['location'];
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && loc) {
      try {
        const redirected = new URL(loc, target).toString();
        return res.redirect(302, '/proxy?url=' + encodeURIComponent(redirected));
      } catch {
        return res.status(502).send('Redirection invalide.');
      }
    }

    /* Headers */
    const BLOCKED = new Set([
      'x-frame-options','content-security-policy',
      'content-security-policy-report-only','strict-transport-security',
      'x-content-type-options','transfer-encoding',
      'content-encoding','content-length','set-cookie',
    ]);
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (!BLOCKED.has(k.toLowerCase())) { try { res.setHeader(k, v); } catch {} }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(proxyRes.statusCode);

    /* Décompression */
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
          text = rewriteHtml(text, target, req.cookies['kyky_off']);
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
   Route /proxy?url=
───────────────────────────────────────*/
app.get('/proxy', (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.redirect(302, FRONTEND_URL);
  fetchAndProxy(raw, req, res);
});

/* ─────────────────────────────────────
   Catch-all SPA
───────────────────────────────────────*/
app.use((req, res) => {
  let baseOrigin = null;

  /* 1. Cookie */
  try {
    const c = req.cookies && req.cookies['kyky_target'];
    if (c) baseOrigin = new URL(decodeURIComponent(c)).origin;
  } catch {}

  /* 2. Referer */
  if (!baseOrigin) {
    try {
      const ref     = new URL(req.headers['referer'] || '');
      const proxied = ref.searchParams.get('url');
      if (proxied) baseOrigin = new URL(proxied).origin;
    } catch {}
  }

  if (baseOrigin) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const targetUrl = baseOrigin + req.path + qs;
    console.log('[catch-all]', req.path, '→', targetUrl);
    return fetchAndProxy(targetUrl, req, res);
  }

  res.redirect(302, FRONTEND_URL);
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

function rewriteHtml(html, base, proxyOff) {
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

  /* Injection script + toggle UI */
  html = html.replace(/<head([^>]*)>/i, m => m + buildInjectedScript(base.origin));
  html = html.replace(/<\/body>/i, buildToggleUI(proxyOff) + '</body>');

  return html;
}

/* ─────────────────────────────────────
   Réécriture JS
───────────────────────────────────────*/
function rewriteJs(js, base) {
  js = js.replace(
    new RegExp(`(['"\`])(https?://${escRx(base.hostname)}[^'"\`\\\\]*)\\1`, 'g'),
    (_, q, url) => `${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(url)}${q}`
  );
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
  console.log(`  Frontend : ${FRONTEND_URL}`);
});
