const express      = require('express');
const https        = require('https');
const http         = require('http');
const zlib         = require('zlib');
const { URL }      = require('url');

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
const FRONTEND_URL   = (process.env.FRONTEND_URL  || 'https://kykyvpn.vercel.app');

app.use((req, res, next) => {
  req.cookies = parseCookies(req);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    req.rawBody = chunks.length ? Buffer.concat(chunks) : null;
    next();
  });
});

app.get('/', (req, res) => {
  res.redirect(302, FRONTEND_URL);
});

app.get('/kyky-toggle', (req, res) => {
  const current = req.cookies['kyky_off'] === '1';
  const next    = current ? '0' : '1';
  res.setHeader('Set-Cookie',
    `kyky_off=${next}; Path=/; Max-Age=86400; SameSite=None; Secure`
  );
  const back = req.headers['referer'] || FRONTEND_URL;
  if (next === '1') {
    try {
      const refUrl  = new URL(back);
      const proxied = refUrl.searchParams.get('url');
      if (proxied) return res.redirect(302, proxied);
    } catch {}
    return res.redirect(302, FRONTEND_URL);
  }
  res.redirect(302, back);
});

const PROXY_COOKIE_KEYS = new Set(['kyky_off', 'kyky_target']);

function buildHeaders(target, reqHeaders) {
  const rawCookie = reqHeaders['cookie'] || '';
  const forwardedCookies = rawCookie
    .split(';').map(c => c.trim())
    .filter(c => { const key = c.split('=')[0].trim(); return key && !PROXY_COOKIE_KEYS.has(key); })
    .join('; ');

  const headers = {
    'Host'                    : target.hostname,
    'User-Agent'              : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'                  : reqHeaders['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language'         : 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding'         : 'gzip, deflate, br',
    'Referer'                 : target.origin + '/',
    'Connection'              : 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest'          : reqHeaders['sec-fetch-dest']  || 'document',
    'Sec-Fetch-Mode'          : reqHeaders['sec-fetch-mode']  || 'navigate',
    'Sec-Fetch-Site'          : 'same-origin',
    'Sec-Fetch-User'          : '?1',
    'Sec-CH-UA'               : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-CH-UA-Mobile'        : '?0',
    'Sec-CH-UA-Platform'      : '"Windows"',
    'Cache-Control'           : 'max-age=0',
    'DNT'                     : '1',
  };

  if (forwardedCookies) headers['Cookie'] = forwardedCookies;

  const passthroughHeaders = ['x-csrftoken', 'x-ig-app-id', 'x-ig-www-claim',
    'x-requested-with', 'x-asbd-id', 'x-fb-friendly-name'];
  for (const h of passthroughHeaders) {
    if (reqHeaders[h]) headers[h] = reqHeaders[h];
  }

  if (reqHeaders['range']) headers['Range'] = reqHeaders['range'];

  return headers;
}

function buildToggleUI(proxyOff) {
  const isOff = proxyOff === '1';
  const label = isOff ? '🔴 Proxy OFF' : '🟢 Proxy ON';
  const bg    = isOff ? '#c0392b'      : '#27ae60';
  return `
<style>
  #kyky-toggle-btn {
    position: fixed; bottom: 18px; right: 18px; z-index: 2147483647;
    background: ${bg}; color: #fff; font-family: sans-serif;
    font-size: 13px; font-weight: 700; padding: 9px 16px;
    border-radius: 50px; box-shadow: 0 4px 15px rgba(0,0,0,.35);
    cursor: pointer; border: none; display: flex; align-items: center; gap: 7px;
    transition: background .2s, transform .1s;
    text-decoration: none !important;
  }
  #kyky-toggle-btn:hover { transform: scale(1.05); filter: brightness(1.1); }
  #kyky-toggle-slider {
    width: 34px; height: 19px; background: rgba(255,255,255,.35);
    border-radius: 10px; position: relative; transition: background .2s;
  }
  #kyky-toggle-slider::after {
    content:''; position:absolute; top:3px;
    left: ${isOff ? '3px' : '15px'};
    width:13px; height:13px; background:#fff;
    border-radius:50%; transition: left .2s;
  }
</style>
<a id="kyky-toggle-btn" href="${PROXY_ORIGIN}/kyky-toggle" title="Activer/désactiver le proxy">
  <span id="kyky-toggle-slider"></span>
  ${label}
</a>`;
}

function buildLogViewerScript(targetOrigin) {
  return `<script data-kyky-logs="1">
(function(){
  var LOGS=[]; var MAX_LOGS=500;
  var counts={all:0,error:0,warn:0,log:0,network:0};
  var activeFilter='all'; var panelOpen=false;
  var fab,panel,logListEl,badgeEl,filterBtns={};
  var STYLES={
    error:{bg:'rgba(255,80,80,.13)',fg:'#ff7a9a',icon:'🔴',label:'error'},
    warn:{bg:'rgba(255,200,0,.11)',fg:'#ffd166',icon:'🟡',label:'warn'},
    log:{bg:'rgba(255,255,255,.03)',fg:'#c8d8f0',icon:'⚪',label:'log'},
    info:{bg:'rgba(77,158,255,.09)',fg:'#7bb8ff',icon:'🔵',label:'log'},
    debug:{bg:'transparent',fg:'#7a8baa',icon:'◻️',label:'log'},
    network:{bg:'rgba(255,120,60,.13)',fg:'#ff9a6b',icon:'🌐',label:'network'},
    promise:{bg:'rgba(255,80,80,.13)',fg:'#ff7a9a',icon:'⚠️',label:'error'},
  };
  function serialize(a){if(a===null)return'null';if(a===undefined)return'undefined';try{if(typeof a==='object')return JSON.stringify(a).slice(0,300);return String(a).slice(0,500);}catch(e){return'[Object]';}}
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  ['log','info','warn','error','debug'].forEach(function(m){var orig=console[m].bind(console);console[m]=function(){orig.apply(console,arguments);addLog(m,Array.prototype.slice.call(arguments).map(serialize).join(' '));};});
  window.addEventListener('error',function(e){var src=e.filename?' ('+e.filename.split('/').pop()+':'+e.lineno+')':'';addLog('error',(e.message||'Script error')+src);},true);
  window.addEventListener('unhandledrejection',function(e){addLog('promise','Unhandled Promise rejection: '+((e.reason&&e.reason.message)?e.reason.message:serialize(e.reason)));});
  var _fetch=window.fetch?window.fetch.bind(window):null;
  if(_fetch){window.fetch=function(input,init){var url=typeof input==='string'?input:(input&&input.url?input.url:String(input));var shortUrl=url.replace(/.*proxy\?url=/,'').slice(0,120);return _fetch(input,init).then(function(res){if(!res.ok)addLog('network','['+res.status+'] '+shortUrl);return res;},function(err){addLog('network','[FAILED] '+shortUrl+' — '+err.message);throw err;});};}
  function addLog(level,msg){var s=STYLES[level]||STYLES.log;var cat=s.label;var entry={level:level,cat:cat,msg:msg,time:now(),s:s};LOGS.push(entry);if(LOGS.length>MAX_LOGS)LOGS.shift();counts.all++;counts[cat]=(counts[cat]||0)+1;updateBadge();if(panelOpen&&logListEl){if(activeFilter==='all'||activeFilter===cat)appendEntry(entry);logListEl.scrollTop=logListEl.scrollHeight;}}
  function now(){var d=new Date();return d.toISOString().slice(11,23);}
  function buildUI(){
    var style=document.createElement('style');style.setAttribute('data-kyky-logs','1');
    style.textContent='#kyky-log-fab{position:fixed;bottom:70px;right:18px;z-index:2147483646;background:#1a2540;color:#7bb8ff;border:1.5px solid rgba(99,153,255,.35);border-radius:50px;padding:7px 14px;font-family:monospace;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4);display:flex;align-items:center;gap:6px;transition:all .2s;white-space:nowrap;}#kyky-log-badge{background:#e74c3c;color:#fff;border-radius:50px;padding:1px 6px;font-size:10px;display:none;}#kyky-log-badge.show{display:inline-block;}#kyky-log-panel{position:fixed;bottom:0;right:0;width:min(600px,100vw);height:min(420px,60vh);background:#0d1530;border:1px solid rgba(99,153,255,.25);border-bottom:none;border-right:none;z-index:2147483645;display:none;flex-direction:column;font-family:monospace;font-size:12px;box-shadow:-4px -4px 30px rgba(0,0,0,.6);}#kyky-log-panel.open{display:flex;}#kyky-log-head{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#111d3a;border-bottom:1px solid rgba(99,153,255,.18);flex-shrink:0;}#kyky-log-list{flex:1;overflow-y:auto;padding:4px 0;}.kyky-entry{display:flex;align-items:flex-start;gap:6px;padding:3px 10px;border-bottom:1px solid rgba(255,255,255,.04);}.kyky-entry-time{color:#2a3a5c;font-size:10px;flex-shrink:0;}.kyky-entry-msg{flex:1;word-break:break-all;white-space:pre-wrap;}';
    document.head.appendChild(style);
    fab=document.createElement('div');fab.id='kyky-log-fab';fab.innerHTML='🐛 Logs <span id="kyky-log-badge"></span>';badgeEl=fab.querySelector('#kyky-log-badge');fab.addEventListener('click',togglePanel);document.body.appendChild(fab);
    panel=document.createElement('div');panel.id='kyky-log-panel';logListEl=document.createElement('div');logListEl.id='kyky-log-list';panel.appendChild(logListEl);document.body.appendChild(panel);
  }
  function appendEntry(entry){if(!logListEl)return;var row=document.createElement('div');row.className='kyky-entry';row.style.background=entry.s.bg;var t=document.createElement('span');t.className='kyky-entry-time';t.textContent=entry.time;var m=document.createElement('span');m.className='kyky-entry-msg';m.style.color=entry.s.fg;m.textContent=entry.msg;row.appendChild(t);row.appendChild(m);logListEl.appendChild(row);}
  function updateBadge(){if(!badgeEl)return;var n=(counts.error||0)+(counts.network||0);if(n>0){badgeEl.textContent=n>99?'99+':String(n);badgeEl.classList.add('show');}else{badgeEl.classList.remove('show');}}
  function togglePanel(){panelOpen=!panelOpen;if(!panel)buildUI();panel.classList.toggle('open',panelOpen);if(panelOpen&&logListEl){logListEl.innerHTML='';LOGS.forEach(appendEntry);logListEl.scrollTop=logListEl.scrollHeight;}}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',buildUI);}else{setTimeout(buildUI,0);}
  addLog('info','[KykyProxy] Log viewer actif — cible : ${targetOrigin}');
})();
</script>`;
}

function buildInjectedScript(targetOrigin) {
  return `<script data-kyky="1">
(function(){
  var PO   = '${PROXY_ORIGIN}';
  var BASE = '${targetOrigin}';
  var PFX  = PO + '/proxy?url=';

  var BYPASS=[
    'imasdk.googleapis.com','apis.google.com','googletagservices.com',
    'googletagmanager.com','doubleclick.net','googlesyndication.com',
    'adservice.google.com','securepubads.g.doubleclick.net',
  ];
  function isBypass(abs){
    try{var h=new URL(abs).hostname;return BYPASS.some(function(d){return h===d||h.slice(-(d.length+1))==='.'+d;});}
    catch(e){return false;}
  }

  function wrap(url){
    if(!url||typeof url!=='string') return url;
    var u=url.trim();
    if(!u||u==='#'||/^(data:|blob:|javascript:|mailto:|about:|tel:)/.test(u)) return url;
    if(u.indexOf(PO)===0) return url;
    try{
      var abs=new URL(u,BASE).href;
      if(abs.indexOf(PO)===0) return url;
      if(isBypass(abs)) return abs;
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

  /* history — intercepter pushState/replaceState pour garder les navigations dans l'iframe */
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

  /* ── INTERCEPTER LES CLICS SUR LES LIENS ──
     But: empêcher les <a href> de naviguer hors de l'iframe.
     On réécrit le href en proxy-URL au moment du clic.
     C'est la clé pour que "changer de page" reste dans l'iframe. */
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || /^(#|javascript:|mailto:|tel:)/.test(href.trim())) return;
    try {
      var abs = new URL(href, BASE).href;
      if (isBypass(abs)) return; // laisser partir directement
      if (abs.indexOf(PO) === 0) return; // déjà proxifié
      e.preventDefault();
      e.stopPropagation();
      // Naviguer dans l'iframe via location.href (reste dans l'iframe)
      location.href = PFX + encodeURIComponent(abs);
    } catch(err) {}
  }, true);

  /* ── INTERCEPTER LES FORMULAIRES ── */
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || !form.action) return;
    try {
      var abs = new URL(form.action, BASE).href;
      if (isBypass(abs)) return;
      if (abs.indexOf(PO) === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Reconstruire l'action en proxy-URL
      form.action = PFX + encodeURIComponent(abs);
      form.submit();
    } catch(err) {}
  }, true);

  /* Worker */
  var _Worker = window.Worker;
  window.Worker = function(url, opts) {
    var wrappedUrl = wrap(url);
    try {
      var patchUrl = PO + '/kyky-worker-patch.js?origin=' + encodeURIComponent(BASE);
      var blob = new Blob([
        'try{importScripts(' + JSON.stringify(patchUrl) + ');}catch(e){}\n' +
        'importScripts(' + JSON.stringify(wrappedUrl) + ');'
      ], { type: 'application/javascript' });
      return new _Worker(URL.createObjectURL(blob), opts);
    } catch(e) {
      return new _Worker(wrappedUrl, opts);
    }
  };

  /* createElement */
  var PROTO_MAP={
    script:[HTMLScriptElement.prototype,['src']],
    img:[HTMLImageElement.prototype,['src','srcset']],
    link:[HTMLLinkElement.prototype,['href']],
    iframe:[HTMLIFrameElement.prototype,['src']],
    source:[HTMLSourceElement.prototype,['src','srcset']],
    video:[HTMLVideoElement.prototype,['src','poster']],
    audio:[HTMLAudioElement.prototype,['src']],
    input:[HTMLInputElement.prototype,['src']],
  };
  function patchEl(el,tag){
    var entry=PROTO_MAP[(tag||'').toLowerCase()];
    if(!entry||el._kyky) return;
    el._kyky=true;
    var proto=entry[0],attrs=entry[1];
    attrs.forEach(function(attr){
      var desc=Object.getOwnPropertyDescriptor(proto,attr);
      if(!desc||!desc.set) return;
      Object.defineProperty(el,attr,{
        get:function(){return desc.get.call(this);},
        set:function(v){
          if(attr==='srcset'){
            v=v.split(',').map(function(p){var parts=p.trim().split(/\s+/);if(parts[0])parts[0]=wrap(parts[0]);return parts.join(' ');}).join(', ');
          } else {v=wrap(v);}
          desc.set.call(this,v);
        },
        configurable:true
      });
    });
  }
  var _create=document.createElement.bind(document);
  document.createElement=function(tag){var el=_create(tag);patchEl(el,tag);return el;};

  var _setAttribute=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){
    var n=name.toLowerCase();
    if((n==='src'||n==='href'||n==='action'||n==='poster')&&typeof value==='string'){value=wrap(value);}
    return _setAttribute.call(this,name,value);
  };

  var _setProperty=CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty=function(prop,val,prio){
    if(typeof val==='string'&&val.indexOf('url(')!==-1){
      val=val.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g,function(_,q,u){return 'url('+q+wrap(u)+q+')';});
    }
    return _setProperty.call(this,prop,val,prio);
  };

  new MutationObserver(function(muts){
    muts.forEach(function(m){m.addedNodes.forEach(function(node){
      if(node.nodeType!==1) return;
      patchEl(node,(node.tagName||'').toLowerCase());
      if(node.querySelectorAll)
        node.querySelectorAll('img,link,script,iframe,source,video,audio').forEach(function(c){patchEl(c,c.tagName.toLowerCase());});
    });});
  }).observe(document.documentElement,{childList:true,subtree:true});

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

/* ─── Proxy central ───*/
function fetchAndProxy(targetUrl, req, res) {
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

  res.setHeader('Set-Cookie', [
    `kyky_target=${encodeURIComponent(target.origin)}; Path=/; Max-Age=3600; SameSite=None; Secure`,
  ]);

  const method  = req.method;
  const driver  = target.protocol === 'https:' ? https : http;
  const options = {
    hostname : target.hostname,
    port     : target.port || (target.protocol === 'https:' ? 443 : 80),
    path     : target.pathname + target.search,
    method   : method,
    headers  : buildHeaders(target, req.headers),
  };

  if (req.rawBody && req.rawBody.length > 0) {
    options.headers['content-length'] = req.rawBody.length;
    if (req.headers['content-type']) {
      options.headers['content-type'] = req.headers['content-type'];
    }
  }

  const proxyReq = driver.request(options, (proxyRes) => {

    if ([400, 404, 410].includes(proxyRes.statusCode)) {
      const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
      const isNonCriticalAsset = ct.includes('image') || ct.includes('font') || ct.includes('woff') || ct.includes('octet-stream');
      if (isNonCriticalAsset) {
        return res.status(204).end();
      }
    }

    /* ─── REDIRECTIONS : toujours vers URL absolue du proxy ───
       CRITICAL FIX : on retourne une URL ABSOLUE (https://kykyproxy.onrender.com/proxy?url=...)
       et non une URL relative (/proxy?url=...).
       Si on renvoie une URL relative, le navigateur la résout par rapport à l'origine
       parente (le frontend KykySearch), ce qui sort l'iframe. */
    const loc = proxyRes.headers['location'];
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && loc) {
      try {
        const redirected = new URL(loc, target).toString();
        // URL ABSOLUE : https://kykyproxy.onrender.com/proxy?url=...
        return res.redirect(302, PROXY_ORIGIN + '/proxy?url=' + encodeURIComponent(redirected));
      } catch {
        return res.status(502).send('Redirection invalide.');
      }
    }

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
    res.setHeader('Access-Control-Allow-Headers', '*');

    /* ─── INJECT FRAME HEADER : permettre l'affichage dans l'iframe depuis notre frontend ─── */
    res.setHeader('X-Frame-Options', `ALLOW-FROM ${PROXY_ORIGIN}`);
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${PROXY_ORIGIN}`);

    res.status(proxyRes.statusCode);

    const encoding    = proxyRes.headers['content-encoding'] || '';
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isCss  = contentType.includes('text/css');

    const reqAccept = (req.headers['accept'] || '').toLowerCase();
    const isApiRequest = reqAccept.includes('application/json') ||
                         reqAccept.includes('application/x-www-form-urlencoded') ||
                         req.headers['x-requested-with'] === 'XMLHttpRequest' ||
                         /\/ajax\/|\/api\/|\/graphql|\/oidc\//.test(target.pathname);
    const treatAsHtml = isHtml && !isApiRequest;

    let stream = proxyRes;
    if      (encoding === 'gzip')    stream = proxyRes.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (encoding === 'br')      stream = proxyRes.pipe(zlib.createBrotliDecompress());

    function onError(err) {
      console.error('[proxy] stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
    }

    if (treatAsHtml) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf-8');
        text = rewriteHtml(text, target, req.cookies['kyky_off']);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(text);
      });
      stream.on('error', onError);
    } else if (isCss) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf-8');
        text = rewriteCss(text, target);
        res.setHeader('content-type', 'text/css; charset=utf-8');
        res.end(text);
      });
      stream.on('error', onError);
    } else if (
      contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
      contentType.includes('vnd.apple.mpegurl') || target.pathname.endsWith('.m3u8')
    ) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf-8');
        text = rewriteM3u8(text, target);
        res.setHeader('content-type', 'application/x-mpegURL; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(text);
      });
      stream.on('error', onError);
    } else {
      const ct2 = contentType || '';
      if (
        ct2.includes('video') || ct2.includes('audio') || ct2.includes('octet-stream') ||
        /\.(ts|mp4|webm|m4s|aac|fmp4)(\?|$)/i.test(target.pathname)
      ) {
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
      }
      stream.pipe(res);
      stream.on('error', onError);
    }
  });

  const isVideoRequest = /\.(m3u8|ts|mp4|webm|m4s|aac|fmp4)(\?|$)/i.test(target.pathname) ||
    target.pathname.includes('/hls/') || target.pathname.includes('/dash/') ||
    target.pathname.includes('/seg') || target.pathname.includes('/chunk');
  const reqTimeout = isVideoRequest ? 60000 : 15000;

  proxyReq.setTimeout(reqTimeout, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).send('Délai dépassé.');
  });
  proxyReq.on('error', err => {
    console.error('[proxy] erreur:', err.message);
    if (!res.headersSent) res.status(502).send('Site indisponible.');
  });

  if (req.rawBody && req.rawBody.length > 0) proxyReq.write(req.rawBody);
  proxyReq.end();
}

app.get('/kyky-worker-patch.js', (req, res) => {
  const origin = req.query.origin || '';
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(`
(function(){
  var PO='${PROXY_ORIGIN}';
  var BASE=decodeURIComponent('${encodeURIComponent(origin)}');
  var BYPASS=['imasdk.googleapis.com','apis.google.com','googletagservices.com','googletagmanager.com','doubleclick.net','googlesyndication.com'];
  function isBypass(abs){try{var h=new URL(abs).hostname;return BYPASS.some(function(d){return h===d||h.endsWith('.'+d);});}catch(e){return false;}}
  function wrap(url){if(!url||typeof url!=='string')return url;var u=url.trim();if(!u||/^(data:|blob:|javascript:)/.test(u))return url;if(u.indexOf(PO)===0)return url;try{var abs=new URL(u,BASE||self.location.href).href;if(abs.indexOf(PO)===0)return url;if(isBypass(abs))return abs;return PO+'/proxy?url='+encodeURIComponent(abs);}catch(e){return url;}}
  var _fetch=self.fetch.bind(self);
  self.fetch=function(input,init){if(typeof input==='string')input=wrap(input);else if(input&&input.url)input=new Request(wrap(input.url),input);return _fetch(input,init);};
  var _xhrOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){var a=[].slice.call(arguments);if(typeof a[1]==='string')a[1]=wrap(a[1]);return _xhrOpen.apply(this,a);};
})();
`);
});

app.all('/proxy', (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.redirect(302, FRONTEND_URL);
  fetchAndProxy(raw, req, res);
});

app.use((req, res) => {
  let baseOrigin = null;
  try {
    const c = req.cookies && req.cookies['kyky_target'];
    if (c) baseOrigin = new URL(decodeURIComponent(c)).origin;
  } catch {}
  if (!baseOrigin) {
    try {
      const ref     = new URL(req.headers['referer'] || '');
      const proxied = ref.searchParams.get('url');
      if (proxied) baseOrigin = new URL(proxied).origin;
    } catch {}
  }
  if (baseOrigin) {
    let targetUrl;
    try { targetUrl = new URL(req.originalUrl, baseOrigin).toString(); }
    catch { targetUrl = baseOrigin + req.originalUrl; }
    console.log('[catch-all]', req.originalUrl, '→', targetUrl);
    return fetchAndProxy(targetUrl, req, res);
  }
  res.redirect(302, FRONTEND_URL);
});

/* ─── Réécriture HTML ─── */
const SKIP = /^(data:|javascript:|mailto:|tel:|#|blob:|about:)/i;
const BYPASS_DOMAINS = [
  'imasdk.googleapis.com','apis.google.com','googletagservices.com',
  'googletagmanager.com','doubleclick.net','googlesyndication.com',
  'adservice.google.com','static.doubleclick.net','securepubads.g.doubleclick.net',
];

function isBypass(url) {
  try { const host = new URL(url).hostname; return BYPASS_DOMAINS.some(d => host === d || host.endsWith('.' + d)); }
  catch { return false; }
}

function toProxyUrl(raw, base) {
  try {
    if (!raw || !raw.trim() || SKIP.test(raw.trim())) return raw;
    const abs = new URL(raw.trim(), base).toString();
    if (abs.startsWith(PROXY_ORIGIN)) return raw;
    if (isBypass(abs)) return abs;
    return PROXY_ORIGIN + '/proxy?url=' + encodeURIComponent(abs);
  } catch { return raw; }
}

function rewriteHtml(html, base, proxyOff) {
  html = html.replace(/\s+integrity\s*=\s*(['"])[^'"]*\1/gi, '');
  html = html.replace(/\s+crossorigin\s*=\s*(['"])[^'"]*\1/gi, '');

  const baseTagMatch = html.match(/<base[^>]+href\s*=\s*['"]([^'"]+)['"]/i);
  if (baseTagMatch) {
    try { base = new URL(baseTagMatch[1], base); } catch {}
    html = html.replace(/<base[^>]*>/gi, '');
  }

  html = html.replace(/((?:href|src|action)\s*=\s*)(['"])(.*?)\2/gi,
    (_, a, q, v) => `${a}${q}${toProxyUrl(v, base)}${q}`);
  html = html.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
    const rw = val.split(',').map(p => { const [u, ...r] = p.trim().split(/\s+/); return u ? [toProxyUrl(u, base), ...r].join(' ') : p; }).join(', ');
    return `srcset=${q}${rw}${q}`;
  });
  html = html.replace(/((?:data-src|data-href|data-original|data-lazy|data-lazy-src|data-url|data-bg|data-background|poster)\s*=\s*)(['"])(.*?)\2/gi,
    (_, a, q, v) => `${a}${q}${toProxyUrl(v, base)}${q}`);
  html = html.replace(/(background\s*=\s*)(['"])(.*?)\2/gi,
    (_, a, q, v) => `${a}${q}${toProxyUrl(v, base)}${q}`);
  html = html.replace(/style\s*=\s*(['"])((?:[^"'\\]|\\.)*?)\1/gi, (_, q, style) => {
    const rw = style.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, sq, u) => `url(${sq}${toProxyUrl(u, base)}${sq})`);
    return `style=${q}${rw}${q}`;
  });
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (_, attrs, css) => `<style${attrs}>${rewriteCss(css, base)}</style>`);
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_, q, u) => `url(${q}${toProxyUrl(u, base)}${q})`);
  html = html.replace(/(content\s*=\s*['"][^'"]*?url=)([^'"&\s]+)/gi,
    (_, pre, u) => `${pre}${toProxyUrl(u, base)}`);

  html = html.replace(/<head([^>]*)>/i, m =>
    m + buildLogViewerScript(base.origin) + buildInjectedScript(base.origin)
  );
  html = html.replace(/<\/body>/i, buildToggleUI(proxyOff) + '</body>');

  return html;
}

function rewriteM3u8(text, base) {
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => 'URI="' + toProxyUrl(uri, base) + '"');
    }
    return toProxyUrl(trimmed, base);
  }).join('\n');
}

function rewriteCss(css, base) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_, q, u) => `url(${q}${toProxyUrl(u, base)}${q})`);
  css = css.replace(/@import\s+(['"])(.*?)\1/gi, (_, q, u) => `@import ${q}${toProxyUrl(u, base)}${q}`);
  css = css.replace(/@import\s+url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, q, u) => `@import url(${q}${toProxyUrl(u, base)}${q})`);
  return css;
}

function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

process.on('uncaughtException', err => console.error('[UNCAUGHT EXCEPTION]', err.stack || err.message));
process.on('unhandledRejection', (reason) => console.error('[UNHANDLED REJECTION]', reason));

app.listen(PORT, () => {
  console.log(`KykyProxy en écoute sur le port ${PORT}`);
  console.log(`  Frontend : ${FRONTEND_URL}`);
});
