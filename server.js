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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* Collecte le body brut pour le forward POST/PUT/PATCH */
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    req.rawBody = chunks.length ? Buffer.concat(chunks) : null;
    next();
  });
});

/* ─────────────────────────────────────
   Page d'accueil → redirige vers le frontend Netlify
───────────────────────────────────────*/
app.get('/', (req, res) => {
  res.redirect(302, FRONTEND_URL);
});

/* ─────────────────────────────────────
   Toggle on/off via cookie
───────────────────────────────────────*/
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

/* ─────────────────────────────────────
   Headers réalistes — anti-Cloudflare / anti-bot
───────────────────────────────────────*/
/* Cookies internes du proxy — à ne pas transmettre au site cible */
const PROXY_COOKIE_KEYS = new Set(['kyky_off', 'kyky_target']);

function buildHeaders(target, reqHeaders) {
  /* Extraire uniquement les cookies destinés au site cible (pas les cookies kyky_*) */
  const rawCookie = reqHeaders['cookie'] || '';
  const forwardedCookies = rawCookie
    .split(';')
    .map(c => c.trim())
    .filter(c => {
      const key = c.split('=')[0].trim();
      return key && !PROXY_COOKIE_KEYS.has(key);
    })
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
    // Origin volontairement absent : le transmettre trahit l'origine proxy
  };

  /* Transmettre les cookies de session au site cible */
  if (forwardedCookies) headers['Cookie'] = forwardedCookies;

  /* Transmettre les headers CSRF/token spécifiques (Instagram, etc.) */
  const passthroughHeaders = ['x-csrftoken', 'x-ig-app-id', 'x-ig-www-claim',
    'x-requested-with', 'x-asbd-id', 'x-fb-friendly-name'];
  for (const h of passthroughHeaders) {
    if (reqHeaders[h]) headers[h] = reqHeaders[h];
  }

  return headers;
}

/* ─────────────────────────────────────
   Toggle UI injecté dans chaque page HTML proxifiée
───────────────────────────────────────*/
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

/* ─────────────────────────────────────
   Log Viewer injecté dans chaque page HTML proxifiée
   Capture: console.*, fetch/XHR errors, window errors, 404s
───────────────────────────────────────*/
function buildLogViewerScript(targetOrigin) {
  return `<script data-kyky-logs="1">
(function(){
  /* ── Storage ── */
  var LOGS = [];
  var MAX_LOGS = 500;
  var counts = { all:0, error:0, warn:0, log:0, network:0 };
  var activeFilter = 'all';
  var panelOpen = false;
  var fab, panel, logListEl, badgeEl, filterBtns = {};

  var STYLES = {
    error:   { bg:'rgba(255,80,80,.13)',  fg:'#ff7a9a', icon:'🔴', label:'error'   },
    warn:    { bg:'rgba(255,200,0,.11)',  fg:'#ffd166', icon:'🟡', label:'warn'    },
    log:     { bg:'rgba(255,255,255,.03)',fg:'#c8d8f0', icon:'⚪', label:'log'     },
    info:    { bg:'rgba(77,158,255,.09)', fg:'#7bb8ff', icon:'🔵', label:'log'     },
    debug:   { bg:'transparent',          fg:'#7a8baa', icon:'◻️', label:'log'     },
    network: { bg:'rgba(255,120,60,.13)', fg:'#ff9a6b', icon:'🌐', label:'network' },
    promise: { bg:'rgba(255,80,80,.13)',  fg:'#ff7a9a', icon:'⚠️', label:'error'   },
  };

  function serialize(a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    try {
      if (typeof a === 'object') return JSON.stringify(a).slice(0, 300);
      return String(a).slice(0, 500);
    } catch(e) { return '[Object]'; }
  }
  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  /* ── Intercept console ── */
  ['log','info','warn','error','debug'].forEach(function(m) {
    var orig = console[m].bind(console);
    console[m] = function() {
      orig.apply(console, arguments);
      var msg = Array.prototype.slice.call(arguments).map(serialize).join(' ');
      addLog(m, msg);
    };
  });

  /* ── Intercept window errors ── */
  window.addEventListener('error', function(e) {
    var src = e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '';
    addLog('error', (e.message||'Script error') + src);
  }, true);
  window.addEventListener('unhandledrejection', function(e) {
    var reason = (e.reason && e.reason.message) ? e.reason.message : serialize(e.reason);
    addLog('promise', 'Unhandled Promise rejection: ' + reason);
  });

  /* ── Intercept fetch ── */
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
      var shortUrl = url.replace(/.*proxy\\?url=/, '').slice(0, 120);
      return _fetch(input, init).then(function(res) {
        if (!res.ok) addLog('network', '[' + res.status + '] ' + shortUrl);
        return res;
      }, function(err) {
        addLog('network', '[FAILED] ' + shortUrl + ' — ' + err.message);
        throw err;
      });
    };
  }

  /* ── Intercept XHR ── */
  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._kykyUrl = String(url).replace(/.*proxy\\?url=/, '').slice(0, 120);
    return _xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    this.addEventListener('load', function() {
      if (self.status >= 400) addLog('network', '[' + self.status + '] XHR ' + (self._kykyUrl||'?'));
    });
    this.addEventListener('error', function() {
      addLog('network', '[FAILED] XHR ' + (self._kykyUrl||'?'));
    });
    return _xhrSend.apply(this, arguments);
  };

  /* ── Add log entry ── */
  function addLog(level, msg) {
    var s = STYLES[level] || STYLES.log;
    var cat = s.label;
    var entry = { level:level, cat:cat, msg:msg, time:now(), s:s };
    LOGS.push(entry);
    if (LOGS.length > MAX_LOGS) LOGS.shift();
    counts.all++;
    counts[cat] = (counts[cat]||0) + 1;
    updateBadge();
    if (panelOpen && logListEl) {
      if (activeFilter === 'all' || activeFilter === cat) appendEntry(entry);
      logListEl.scrollTop = logListEl.scrollHeight;
    }
  }

  function now() {
    var d = new Date();
    return d.toISOString().slice(11,23);
  }

  /* ── Build UI (deferred) ── */
  function buildUI() {
    var style = document.createElement('style');
    style.setAttribute('data-kyky-logs', '1');
    style.textContent = [
      '#kyky-log-fab{position:fixed;bottom:70px;right:18px;z-index:2147483646;',
      'background:#1a2540;color:#7bb8ff;border:1.5px solid rgba(99,153,255,.35);',
      'border-radius:50px;padding:7px 14px;font-family:monospace;font-size:12px;',
      'font-weight:700;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4);',
      'display:flex;align-items:center;gap:6px;transition:all .2s;white-space:nowrap;}',
      '#kyky-log-fab:hover{border-color:#4d9eff;background:#1e2d58;}',
      '#kyky-log-badge{background:#e74c3c;color:#fff;border-radius:50px;',
      'padding:1px 6px;font-size:10px;display:none;}',
      '#kyky-log-badge.show{display:inline-block;}',
      '#kyky-log-panel{position:fixed;bottom:0;right:0;width:min(600px,100vw);',
      'height:min(420px,60vh);background:#0d1530;border:1px solid rgba(99,153,255,.25);',
      'border-bottom:none;border-right:none;z-index:2147483645;display:none;',
      'flex-direction:column;font-family:monospace;font-size:12px;',
      'box-shadow:-4px -4px 30px rgba(0,0,0,.6);}',
      '#kyky-log-panel.open{display:flex;}',
      '#kyky-log-head{display:flex;align-items:center;gap:6px;padding:7px 10px;',
      'background:#111d3a;border-bottom:1px solid rgba(99,153,255,.18);flex-shrink:0;}',
      '#kyky-log-head span{color:#4d9eff;font-size:11px;font-weight:700;flex:1;}',
      '.kyky-fbtn{background:rgba(77,158,255,.1);border:1px solid rgba(77,158,255,.2);',
      'color:#7bb8ff;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;',
      'font-family:monospace;transition:all .15s;}',
      '.kyky-fbtn:hover,.kyky-fbtn.active{background:rgba(77,158,255,.28);',
      'border-color:#4d9eff;color:#fff;}',
      '.kyky-fbtn.f-error.active{background:rgba(255,80,80,.2);border-color:#ff6b8a;color:#ff6b8a;}',
      '.kyky-fbtn.f-warn.active{background:rgba(255,200,0,.15);border-color:#ffd166;color:#ffd166;}',
      '.kyky-fbtn.f-network.active{background:rgba(255,120,60,.2);border-color:#ff9a6b;color:#ff9a6b;}',
      '#kyky-log-clear{background:transparent;border:none;color:#4e6491;cursor:pointer;',
      'font-size:16px;padding:0 4px;line-height:1;transition:color .15s;}',
      '#kyky-log-clear:hover{color:#ff6b8a;}',
      '#kyky-log-close{background:transparent;border:none;color:#4e6491;cursor:pointer;',
      'font-size:18px;padding:0 4px;line-height:1;transition:color .15s;}',
      '#kyky-log-close:hover{color:#e74c3c;}',
      '#kyky-log-list{flex:1;overflow-y:auto;padding:4px 0;}',
      '#kyky-log-list::-webkit-scrollbar{width:4px;}',
      '#kyky-log-list::-webkit-scrollbar-track{background:#0d1530;}',
      '#kyky-log-list::-webkit-scrollbar-thumb{background:#1e2d58;border-radius:2px;}',
      '.kyky-entry{display:flex;align-items:flex-start;gap:6px;padding:3px 10px;',
      'border-bottom:1px solid rgba(255,255,255,.04);line-height:1.5;}',
      '.kyky-entry:hover{background:rgba(255,255,255,.03);}',
      '.kyky-entry-time{color:#2a3a5c;font-size:10px;flex-shrink:0;padding-top:1px;}',
      '.kyky-entry-icon{flex-shrink:0;font-size:10px;padding-top:2px;}',
      '.kyky-entry-msg{flex:1;word-break:break-all;white-space:pre-wrap;color:#c8d8f0;}',
      '#kyky-log-empty{color:#2a3a5c;text-align:center;padding:30px;font-size:11px;}',
    ].join('');
    document.head.appendChild(style);

    /* FAB */
    fab = document.createElement('div');
    fab.id = 'kyky-log-fab';
    fab.innerHTML = '🐛 Logs <span id="kyky-log-badge"></span>';
    badgeEl = fab.querySelector('#kyky-log-badge');
    fab.addEventListener('click', togglePanel);
    document.body.appendChild(fab);

    /* Panel */
    panel = document.createElement('div');
    panel.id = 'kyky-log-panel';

    var head = document.createElement('div');
    head.id = 'kyky-log-head';

    var title = document.createElement('span');
    title.textContent = '🐛 KykyProxy Console';

    var filters = [
      ['all',     'All',     ''],
      ['error',   'Errors',  'f-error'],
      ['warn',    'Warns',   'f-warn'],
      ['log',     'Logs',    ''],
      ['network', 'Network', 'f-network'],
    ];
    filters.forEach(function(f) {
      var btn = document.createElement('button');
      btn.className = 'kyky-fbtn ' + f[2];
      btn.textContent = f[1];
      if (f[0] === 'all') btn.classList.add('active');
      btn.addEventListener('click', function() { setFilter(f[0]); });
      filterBtns[f[0]] = btn;
      head.appendChild(btn);
    });

    var clearBtn = document.createElement('button');
    clearBtn.id = 'kyky-log-clear';
    clearBtn.title = 'Vider les logs';
    clearBtn.textContent = '🗑';
    clearBtn.addEventListener('click', clearLogs);

    var closeBtn = document.createElement('button');
    closeBtn.id = 'kyky-log-close';
    closeBtn.title = 'Fermer';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', togglePanel);

    head.insertBefore(title, head.firstChild);
    head.appendChild(clearBtn);
    head.appendChild(closeBtn);

    logListEl = document.createElement('div');
    logListEl.id = 'kyky-log-list';

    panel.appendChild(head);
    panel.appendChild(logListEl);
    document.body.appendChild(panel);
  }

  function appendEntry(entry) {
    if (!logListEl) return;
    var empty = logListEl.querySelector('#kyky-log-empty');
    if (empty) empty.remove();

    var row = document.createElement('div');
    row.className = 'kyky-entry';
    row.style.background = entry.s.bg;

    var timeEl = document.createElement('span');
    timeEl.className = 'kyky-entry-time';
    timeEl.textContent = entry.time;

    var icon = document.createElement('span');
    icon.className = 'kyky-entry-icon';
    icon.textContent = entry.s.icon;

    var msg = document.createElement('span');
    msg.className = 'kyky-entry-msg';
    msg.style.color = entry.s.fg;
    msg.textContent = entry.msg;

    row.appendChild(timeEl);
    row.appendChild(icon);
    row.appendChild(msg);
    logListEl.appendChild(row);
  }

  function renderAll() {
    if (!logListEl) return;
    logListEl.innerHTML = '';
    var filtered = LOGS.filter(function(e) {
      return activeFilter === 'all' || e.cat === activeFilter;
    });
    if (filtered.length === 0) {
      logListEl.innerHTML = '<div id="kyky-log-empty">Aucun log pour cette catégorie</div>';
      return;
    }
    filtered.forEach(appendEntry);
    logListEl.scrollTop = logListEl.scrollHeight;
  }

  function setFilter(f) {
    activeFilter = f;
    Object.keys(filterBtns).forEach(function(k) {
      filterBtns[k].classList.toggle('active', k === f);
    });
    renderAll();
  }

  function clearLogs() {
    LOGS = [];
    counts = { all:0, error:0, warn:0, log:0, network:0 };
    if (logListEl) logListEl.innerHTML = '';
    updateBadge();
  }

  function updateBadge() {
    if (!badgeEl) return;
    var n = (counts.error||0) + (counts.network||0);
    if (n > 0) {
      badgeEl.textContent = n > 99 ? '99+' : String(n);
      badgeEl.classList.add('show');
    } else {
      badgeEl.classList.remove('show');
    }
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    if (!panel) { buildUI(); }
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) {
      renderAll();
      // Ajuster position FAB si panel ouvert
      if (fab) fab.style.bottom = (Math.min(420, window.innerHeight * 0.6) + 10) + 'px';
    } else {
      if (fab) fab.style.bottom = '70px';
    }
  }

  /* Construire l'UI dès que le DOM est prêt */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    setTimeout(buildUI, 0);
  }

  addLog('info', '[KykyProxy] Log viewer actif — cible : ${targetOrigin}');
})();
</script>`;
}

/* ─────────────────────────────────────
   Script de réécriture dynamique injecté dans chaque HTML
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
    if(!u||u==='#'||/^(data:|blob:|javascript:|mailto:|about:|tel:)/.test(u)) return url;
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

  /* dynamic import() */
  try {
    var _importOrig = Function.prototype.call.bind(Function.prototype.call,
      Object.getPrototypeOf(async function(){}).constructor);
  } catch(e){}

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

  /* Worker */
  var _Worker = window.Worker;
  window.Worker = function(url, opts) {
    return new _Worker(wrap(url), opts);
  };

  /* createElement */
  var PROTO_MAP={
    script: [HTMLScriptElement.prototype,   ['src']],
    img:    [HTMLImageElement.prototype,    ['src','srcset']],
    link:   [HTMLLinkElement.prototype,     ['href']],
    iframe: [HTMLIFrameElement.prototype,   ['src']],
    source: [HTMLSourceElement.prototype,   ['src','srcset']],
    video:  [HTMLVideoElement.prototype,    ['src','poster']],
    audio:  [HTMLAudioElement.prototype,    ['src']],
    input:  [HTMLInputElement.prototype,    ['src']],
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

  /* Patch setAttribute pour src/href dynamiques */
  var _setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    var n = name.toLowerCase();
    if((n==='src'||n==='href'||n==='action'||n==='poster')&&typeof value==='string'){
      value = wrap(value);
    }
    return _setAttribute.call(this, name, value);
  };

/* Patch style.backgroundImage etc */
var _setProperty = CSSStyleDeclaration.prototype.setProperty;
CSSStyleDeclaration.prototype.setProperty = function(prop, val, prio) {
  if (typeof val === 'string' && val.indexOf('url(') !== -1) {
    val = val.replace(/url\(\s*(['"]?)([^'")]+)\\1\s*\)/g, function(_, q, u) {
      return 'url(' + q + wrap(u) + q + ')';
    });
  }
  return _setProperty.call(this, prop, val, prio);
};

  /* MutationObserver */
  function patchNode(node){
    if(node.nodeType!==1) return;
    var tag=(node.tagName||'').toLowerCase();
    patchEl(node,tag);
    if(node.querySelectorAll)
      node.querySelectorAll('img,link,script,iframe,source,video,audio').forEach(function(c){
        patchEl(c,c.tagName.toLowerCase());
      });
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

  /* Forward du body pour POST / PUT / PATCH */
  if (req.rawBody && req.rawBody.length > 0) {
    options.headers['content-length'] = req.rawBody.length;
    if (req.headers['content-type']) {
      options.headers['content-type'] = req.headers['content-type'];
    }
  }

  const proxyReq = driver.request(options, (proxyRes) => {

    /* Assets bloqués / introuvables — on répond 204 pour ne pas casser la page */
    if ([400, 404, 410].includes(proxyRes.statusCode)) {
      const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
      const isAsset = ct.includes('javascript') || ct.includes('css') ||
                      ct.includes('image') || ct.includes('font') ||
                      ct.includes('woff') || ct.includes('octet-stream');
      if (isAsset) {
        console.log('[blocked asset]', proxyRes.statusCode, targetUrl);
        return res.status(204).end();
      }
    }

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

    /* Headers — on retire les bloquants */
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
    res.status(proxyRes.statusCode);

    /* Décompression */
    const encoding    = proxyRes.headers['content-encoding'] || '';
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isJs   = contentType.includes('javascript');
    const isCss  = contentType.includes('text/css');

    /* Ne pas réécrire le HTML si la requête ressemble à un appel API
       (le site renvoie une page d'erreur HTML au lieu de JSON) */
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
      /* Buffer uniquement le HTML (nécessite réécriture) */
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf-8');
        text = rewriteHtml(text, target, req.cookies['kyky_off']);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(text);
      });
      stream.on('error', onError);
    } else if (isJs || isCss) {
      /* JS et CSS : buffer pour réécriture mais on limite la taille */
      const chunks = [];
      let totalSize = 0;
      const MAX_REWRITE_SIZE = 5 * 1024 * 1024; // 5 MB max, au-delà on pipe direct
      stream.on('data', c => {
        totalSize += c.length;
        if (totalSize > MAX_REWRITE_SIZE) {
          /* Trop gros : on pipe le reste directement sans réécrire */
          stream.removeAllListeners('data');
          stream.removeAllListeners('end');
          res.write(Buffer.concat(chunks));
          stream.pipe(res);
        } else {
          chunks.push(c);
        }
      });
      stream.on('end', () => {
        if (totalSize <= MAX_REWRITE_SIZE) {
          let text = Buffer.concat(chunks).toString('utf-8');
          if (isJs) {
            text = rewriteJs(text, target);
            res.setHeader('content-type', 'application/javascript; charset=utf-8');
          } else {
            text = rewriteCss(text, target);
            res.setHeader('content-type', 'text/css; charset=utf-8');
          }
          res.end(text);
        }
      });
      stream.on('error', onError);
    } else {
      stream.pipe(res);
      stream.on('error', onError);
    }
  });

  proxyReq.setTimeout(10000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).send('Délai dépassé.');
  });
  proxyReq.on('error', err => {
    console.error('[proxy] erreur:', err.message);
    if (!res.headersSent) res.status(502).send('Site indisponible.');
  });

  /* Envoyer le body si présent (POST / PUT / PATCH) */
  if (req.rawBody && req.rawBody.length > 0) {
    proxyReq.write(req.rawBody);
  }
  proxyReq.end();
}

/* ─────────────────────────────────────
   Route /proxy?url=
───────────────────────────────────────*/
app.all('/proxy', (req, res) => {
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
    let targetUrl;
    try {
      targetUrl = new URL(req.originalUrl, baseOrigin).toString();
    } catch {
      targetUrl = baseOrigin + req.originalUrl;
    }
    console.log('[catch-all]', req.originalUrl, '→', targetUrl);
    return fetchAndProxy(targetUrl, req, res);
  }

  res.redirect(302, FRONTEND_URL);
});

/* ─────────────────────────────────────
   Réécriture HTML — version renforcée
───────────────────────────────────────*/
const SKIP = /^(data:|javascript:|mailto:|tel:|#|blob:|about:)/i;

function toProxyUrl(raw, base) {
  try {
    if (!raw || !raw.trim() || SKIP.test(raw.trim())) return raw;
    const abs = new URL(raw.trim(), base).toString();
    if (abs.startsWith(PROXY_ORIGIN)) return raw;
    return PROXY_ORIGIN + '/proxy?url=' + encodeURIComponent(abs);
  } catch { return raw; }
}

function rewriteHtml(html, base, proxyOff) {
  /* 0. Supprimer les attributs integrity (SRI) — évite les erreurs de hash après réécriture */
  html = html.replace(/\s+integrity\s*=\s*(['"])[^'"]*\1/gi, '');
  html = html.replace(/\s+crossorigin\s*=\s*(['"])[^'"]*\1/gi, '');

  /* 0b. Extraire <base href> si présent et l'utiliser comme base */
  const baseTagMatch = html.match(/<base[^>]+href\s*=\s*['"]([^'"]+)['"]/i);
  if (baseTagMatch) {
    try { base = new URL(baseTagMatch[1], base); } catch {}
    /* Supprimer le <base href> pour éviter qu'il interfère côté client */
    html = html.replace(/<base[^>]*>/gi, '');
  }

  /* 1. Attributs standards : href, src, action */
  html = html.replace(/((?:href|src|action)\s*=\s*)(['"])(.*?)\2/gi,
    (_, a, q, v) => `${a}${q}${toProxyUrl(v, base)}${q}`);

  /* 2. srcset */
  html = html.replace(/srcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
    const rw = val.split(',').map(p => {
      const [u, ...r] = p.trim().split(/\s+/);
      return u ? [toProxyUrl(u, base), ...r].join(' ') : p;
    }).join(', ');
    return `srcset=${q}${rw}${q}`;
  });

  /* 3. Attributs lazy-loading / data attributes courants */
  html = html.replace(
    /((?:data-src|data-href|data-original|data-lazy|data-lazy-src|data-url|data-bg|data-background|poster)\s*=\s*)(['"])(.*?)\2/gi,
    (_, a, q, v) => `${a}${q}${toProxyUrl(v, base)}${q}`
  );

  /* 4. Attribut background (tables, td legacy) */
  html = html.replace(/(background\s*=\s*)(['"])(.*?)\2/gi,
    (_, a, q, v) => `${a}${q}${toProxyUrl(v, base)}${q}`);

  /* 5. url() dans les attributs style inline */
  html = html.replace(/style\s*=\s*(['"])((?:[^"'\\]|\\.)*?)\1/gi, (_, q, style) => {
    const rw = style.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
      (m, sq, u) => `url(${sq}${toProxyUrl(u, base)}${sq})`);
    return `style=${q}${rw}${q}`;
  });

  /* 6. Blocs <style>...</style> */
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (_, attrs, css) => `<style${attrs}>${rewriteCss(css, base)}</style>`);

  /* 7. url() hors attributs (ex: CSS inline dans HTML brut) */
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_, q, u) => `url(${q}${toProxyUrl(u, base)}${q})`);

  /* 8. meta refresh */
  html = html.replace(/(content\s*=\s*['"][^'"]*?url=)([^'"&\s]+)/gi,
    (_, pre, u) => `${pre}${toProxyUrl(u, base)}`);

  /* 9. import() dynamique dans les scripts inline */
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs, code) => {
    if (/data-kyky/.test(attrs)) return whole; // ne pas toucher nos scripts
    const rw = rewriteJs(code, base);
    return `<script${attrs}>${rw}</script>`;
  });

  /* 10. Injection log viewer (avant tout) + script proxy + toggle UI */
  html = html.replace(/<head([^>]*)>/i, m =>
    m + buildLogViewerScript(base.origin) + buildInjectedScript(base.origin)
  );
  html = html.replace(/<\/body>/i, buildToggleUI(proxyOff) + '</body>');

  return html;
}

/* ─────────────────────────────────────
   Réécriture JS
───────────────────────────────────────*/
function rewriteJs(js, base) {
  /* URLs absolues du domaine cible dans les strings */
  js = js.replace(
    new RegExp(`(['"\`])(https?://${escRx(base.hostname)}[^'"\`\\\\]*)\\1`, 'g'),
    (_, q, url) => `${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(url)}${q}`
  );
  /* Webpack public path */
  js = js.replace(
    /(__webpack_require__\s*\.\s*p\s*=\s*)(['"`])(https?:\/\/[^'"`]+|\/[^'"`]*)(['"`])/g,
    (_, pre, q, path, q2) => {
      const abs = path.startsWith('http') ? path : base.origin + path;
      return `${pre}${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(abs)}${q2}`;
    }
  );
  /* import() dynamique avec string littérale */
  js = js.replace(
    /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    (_, q, url) => {
      try {
        const abs = new URL(url, base).toString();
        return `import(${q}${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(abs)}${q})`;
      } catch { return url; }
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
  css = css.replace(/@import\s+url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_, q, u) => `@import url(${q}${toProxyUrl(u, base)}${q})`);
  return css;
}

function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ─────────────────────────────────────
   Démarrage
───────────────────────────────────────*/
process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

app.listen(PORT, () => {
  console.log(`KykyProxy en écoute sur le port ${PORT}`);
  console.log(`  Frontend : ${FRONTEND_URL}`);
});
