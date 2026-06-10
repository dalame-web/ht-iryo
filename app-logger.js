/* HT Iryo — Log de diagnóstico de sesión (temporal, para pruebas).
 *
 * Captura cómo y cuándo la app obtiene la localización, qué hace al fallar,
 * marcas (GPS/estimada/manual), acciones del usuario y ciclo de vida.
 *
 * Sin invasión: no toca gps-tracking.js. Engancha por wrapping de
 * navigator.geolocation, navigator.wakeLock, localStorage.setItem y los
 * métodos públicos de window.HTIryo.
 *
 * Para desinstalar: borrar este archivo + 1 <meta> + 1 <script> en index.html
 * + 1 línea en sw.js. Cero código residual.
 */
(function(){
  'use strict';

  var LOG_KEY = 'ebula_applog_v1';
  var MAX_ENTRIES = 3000;
  var TRIM_TO = 2400;

  function nowIso(){ return new Date().toISOString(); }
  function randId(){ return Math.random().toString(16).slice(2,10); }

  var sessionId = randId();
  var swVersion = 'unknown';
  try {
    var meta = document.querySelector('meta[name="ebula-version"]');
    if(meta && meta.getAttribute('content')) swVersion = meta.getAttribute('content');
  } catch(e){}

  function appendEntry(level, cat, msg, data){
    try {
      var arr;
      try { arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch(e){ arr = []; }
      if(!arr || arr.constructor !== Array) arr = [];
      var entry = { ts: nowIso(), level: level, cat: cat, msg: msg };
      if(data != null) entry.data = data;
      arr.push(entry);
      if(arr.length > MAX_ENTRIES) arr = arr.slice(-TRIM_TO);
      localStorage.setItem(LOG_KEY, JSON.stringify(arr));
    } catch(e){}
  }

  var AppLogger = {
    log: appendEntry,
    export: function(){
      var arr;
      try { arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch(e){ arr = []; }
      if(!arr || arr.constructor !== Array) arr = [];
      var lines = [];
      for(var i=0; i<arr.length; i++){
        try { lines.push(JSON.stringify(arr[i])); } catch(e){}
      }
      return lines.join('\n');
    },
    clear: function(){ try { localStorage.removeItem(LOG_KEY); } catch(e){} },
    getSessionId: function(){ return sessionId; }
  };
  window.AppLogger = AppLogger;

  // ---- Entrada inicial de sesión ------------------------------------------------
  function emitSessionEntry(extra){
    var data = {
      sessionId: sessionId,
      swVersion: swVersion,
      ua: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      online: navigator.onLine,
      screen: { w: (screen && screen.width)||null, h: (screen && screen.height)||null, dpr: window.devicePixelRatio||null }
    };
    if(extra) for(var k in extra) data[k] = extra[k];
    appendEntry('info', 'sesion', 'inicio', data);
  }
  emitSessionEntry();

  // ---- Errores JS y promesas no manejadas ---------------------------------------
  var prevOnError = window.onerror;
  window.onerror = function(msg, src, line, col, err){
    appendEntry('error', 'js_error', String(msg), {
      src: src, line: line, col: col,
      stack: (err && err.stack) ? String(err.stack) : null
    });
    if(typeof prevOnError === 'function') try { return prevOnError.apply(this, arguments); } catch(e){}
    return false;
  };
  window.addEventListener('unhandledrejection', function(ev){
    var reason = ev && ev.reason;
    appendEntry('error', 'promise_rejection', reason ? String(reason) : 'unknown', {
      stack: (reason && reason.stack) ? String(reason.stack) : null
    });
  });

  // ---- Helpers que necesitan HTIryo ---------------------------------------------
  function H(){ return window.HTIryo; }
  function serviceInfo(){
    try {
      var api = H();
      if(!api) return {};
      var m = api.getMarch && api.getMarch();
      var tk = api.getTickKey && api.getTickKey();
      var info = { tickKey: tk || null };
      if(m){ info.t = m.t || null; info.o = m.o || null; info.d = m.d || null; }
      return info;
    } catch(e){ return {}; }
  }
  function stationName(idx){
    try {
      var m = H() && H().getMarch && H().getMarch();
      if(!m || !m.s || !m.s[idx]) return null;
      return m.s[idx].n || null;
    } catch(e){ return null; }
  }

  // ---- Wrap navigator.geolocation -----------------------------------------------
  // Captura cada lectura GPS (lat/lng/accuracy completos) y cada error de lectura.
  // gps-tracking.js usa getCurrentPosition; watchPosition se wrappea por simetría.
  (function(){
    if(!navigator.geolocation) return;
    var geo = navigator.geolocation;
    function wrapCallbacks(method){
      var orig = geo[method];
      if(typeof orig !== 'function') return;
      geo[method] = function(success, error, opts){
        function wSuccess(pos){
          try {
            var c = pos && pos.coords;
            appendEntry('info', 'gps', 'lectura', {
              lat: c ? c.latitude : null,
              lng: c ? c.longitude : null,
              accuracy: c ? c.accuracy : null,
              altitude: c ? c.altitude : null,
              altitudeAccuracy: c ? c.altitudeAccuracy : null,
              heading: c ? c.heading : null,
              speed: c ? c.speed : null,
              ts_gps: pos ? pos.timestamp : null,
              via: method,
              service: serviceInfo()
            });
          } catch(e){}
          if(typeof success === 'function') success(pos);
        }
        function wError(err){
          try {
            appendEntry('warn', 'gps', 'error_lectura', {
              code: err ? err.code : null,
              message: err ? String(err.message || '') : null,
              via: method,
              service: serviceInfo()
            });
          } catch(e){}
          if(typeof error === 'function') error(err);
        }
        return orig.call(geo, wSuccess, wError, opts);
      };
    }
    wrapCallbacks('getCurrentPosition');
    wrapCallbacks('watchPosition');
  })();

  // ---- Wrap navigator.wakeLock --------------------------------------------------
  (function(){
    if(!('wakeLock' in navigator) || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
    var origReq = navigator.wakeLock.request.bind(navigator.wakeLock);
    navigator.wakeLock.request = function(type){
      var p = origReq(type);
      p.then(function(wl){
        appendEntry('info', 'lifecycle', 'wakelock_concedido', { type: type });
        try {
          wl.addEventListener('release', function(){
            appendEntry('info', 'lifecycle', 'wakelock_liberado');
          });
        } catch(e){}
        return wl;
      }, function(err){
        appendEntry('warn', 'lifecycle', 'wakelock_denegado', {
          message: err ? String(err.message || err) : null
        });
      });
      return p;
    };
  })();

  // ---- Wrap localStorage.setItem -------------------------------------------------
  // Filtra estrictamente claves de punteo + fuente de marca. Diff para detectar
  // alta/baja/reset. Una bandera evita doble-logueo cuando el origen es HTIryo.setMark
  // (que ya se captura por separado).
  var setMarkInProgress = false;
  (function(){
    var origSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(key, value){
      var prev = null;
      if(key === 'ebula_punches_v2' && !setMarkInProgress){
        try { prev = localStorage.getItem(key); } catch(e){}
      }
      var r = origSet(key, value);
      if(key === 'ebula_punches_v2' && !setMarkInProgress){
        try {
          var diff = diffPunches(prev, value);
          if(diff){
            if(diff.type === 'reset'){
              appendEntry('info', 'accion_usuario', 'reset_punteo', { service: serviceInfo() });
            } else if(diff.type === 'alta'){
              appendEntry('info', 'accion_usuario', 'marca_alta_tabla', {
                idx: diff.idx, hhmm: diff.hhmm, name: stationName(diff.idx), service: serviceInfo()
              });
            } else if(diff.type === 'baja'){
              appendEntry('info', 'accion_usuario', 'marca_baja_tabla', {
                idx: diff.idx, name: stationName(diff.idx), service: serviceInfo()
              });
            }
          }
        } catch(e){}
      }
      return r;
    };
  })();

  function diffPunches(oldStr, newStr){
    var oldObj = {}, newObj = {};
    try { if(oldStr) oldObj = JSON.parse(oldStr) || {}; } catch(e){}
    try { if(newStr) newObj = JSON.parse(newStr) || {}; } catch(e){}
    var tk = (serviceInfo() || {}).tickKey;
    if(!tk) return null;
    var oldP = oldObj[tk] || {};
    var newP = newObj[tk] || {};
    var oldKeys = Object.keys(oldP), newKeys = Object.keys(newP);
    if(oldKeys.length > 0 && newKeys.length === 0) return { type: 'reset' };
    for(var i=0; i<newKeys.length; i++){
      var k = newKeys[i];
      if(newP[k] !== oldP[k]) return { type: 'alta', idx: +k, hhmm: newP[k] };
    }
    for(var j=0; j<oldKeys.length; j++){
      var kk = oldKeys[j];
      if(!(kk in newP)) return { type: 'baja', idx: +kk };
    }
    return null;
  }

  // ---- Wrap HTIryo (cuando esté disponible) -------------------------------------
  // index.html crea window.HTIryo de forma síncrona durante el parseo de su script
  // principal. Como app-logger.js se carga DESPUÉS de ese script y ANTES de
  // gps-tracking.js, HTIryo ya existe aquí; los wraps aplican antes de cualquier
  // uso por gps-tracking.js.
  function wrapHTIryo(){
    var api = H();
    if(!api) return false;
    // setMark: lo llama gps-tracking.js (autoMark / estimateMark). Capta source.
    if(typeof api.setMark === 'function' && !api.setMark.__alWrapped){
      var origSetMark = api.setMark;
      api.setMark = function(idx, hhmm, source){
        appendEntry('info', 'gps', 'mark', {
          idx: idx, hhmm: hhmm, source: source || 'gps',
          name: stationName(idx),
          service: serviceInfo()
        });
        setMarkInProgress = true;
        try { return origSetMark.apply(this, arguments); }
        finally { setMarkInProgress = false; }
      };
      api.setMark.__alWrapped = true;
    }
    // setProvisionalDelay: cambios del retraso provisional. Deduplica por valor entero.
    if(typeof api.setProvisionalDelay === 'function' && !api.setProvisionalDelay.__alWrapped){
      var origSPD = api.setProvisionalDelay;
      var lastProv = undefined;
      api.setProvisionalDelay = function(min){
        var norm = (min == null) ? null : Math.round(min);
        if(norm !== lastProv){
          appendEntry('info', 'gps', 'retraso_provisional', {
            min: norm, prev: lastProv === undefined ? null : lastProv
          });
          lastProv = norm;
        }
        return origSPD.apply(this, arguments);
      };
      api.setProvisionalDelay.__alWrapped = true;
    }
    // logManualMark: marca manual con GPS activo.
    if(typeof api.logManualMark === 'function' && !api.logManualMark.__alWrapped){
      var origLMM = api.logManualMark;
      api.logManualMark = function(idx){
        appendEntry('info', 'accion_usuario', 'marca_manual_post_gps', {
          idx: idx, name: stationName(idx), service: serviceInfo()
        });
        return origLMM.apply(this, arguments);
      };
      api.logManualMark.__alWrapped = true;
    }
    // Cambio de marcha
    if(typeof api.onMarchaChange === 'function' && !api.__alMarchaHooked){
      api.onMarchaChange(function(){
        appendEntry('info', 'accion_usuario', 'cambio_marcha', { service: serviceInfo() });
      });
      api.__alMarchaHooked = true;
    }
    return true;
  }

  // Reintenta hasta que TODOS los métodos esperados estén wrappeados.
  // setMark/setProvisionalDelay existen ya cuando index.html crea HTIryo,
  // pero logManualMark lo añade gps-tracking.js al final de su IIFE,
  // así que necesitamos reintentar tras su carga.
  function fullyWrapped(){
    var a = H();
    return !!(a && a.setMark && a.setMark.__alWrapped
              && a.setProvisionalDelay && a.setProvisionalDelay.__alWrapped
              && a.logManualMark && a.logManualMark.__alWrapped);
  }
  wrapHTIryo();
  if(!fullyWrapped()){
    var tries = 0;
    var iv = setInterval(function(){
      tries++;
      wrapHTIryo();
      if(fullyWrapped() || tries > 50){ clearInterval(iv); }
    }, 100);
  }

  // ---- Polling de isTracking para detectar start/stop ----------------------------
  (function(){
    var last = null;
    setInterval(function(){
      try {
        var api = H();
        if(!api || typeof api.isTracking !== 'function') return;
        var t = !!api.isTracking();
        if(t !== last){
          if(t){
            // Nuevo servicio: borrar log previo (1 servicio = 1 log).
            // Rota sessionId, reemite entrada de sesión, marca tracking_start.
            var prevSessionId = sessionId;
            try { localStorage.removeItem(LOG_KEY); } catch(e){}
            sessionId = randId();
            emitSessionEntry({ reset_motivo: 'tracking_start', prevSessionId: prevSessionId });
            appendEntry('info', 'gps', 'tracking_start', {
              service: serviceInfo(),
              nota: (last === null) ? 'detectado_en_arranque' : undefined
            });
          } else if(last !== null){
            appendEntry('info', 'gps', 'tracking_stop', { service: serviceInfo() });
          }
          last = t;
        }
      } catch(e){}
    }, 2000);
  })();

  // ---- Ciclo de vida ------------------------------------------------------------
  document.addEventListener('visibilitychange', function(){
    var tracking = false;
    try { tracking = !!(H() && H().isTracking && H().isTracking()); } catch(e){}
    appendEntry('info', 'lifecycle', 'visibility', { hidden: document.hidden, tracking: tracking });
  });
  window.addEventListener('online', function(){ appendEntry('info', 'lifecycle', 'online'); });
  window.addEventListener('offline', function(){ appendEntry('info', 'lifecycle', 'offline'); });

  // ---- Permiso GPS --------------------------------------------------------------
  (function(){
    if(!navigator.permissions || !navigator.permissions.query) return;
    try {
      navigator.permissions.query({name:'geolocation'}).then(function(p){
        var prev = p.state;
        appendEntry('info', 'gps_perm', 'estado_inicial', { state: prev });
        try {
          p.addEventListener ? p.addEventListener('change', onChange)
                             : (p.onchange = onChange);
        } catch(e){ p.onchange = onChange; }
        function onChange(){
          appendEntry('info', 'gps_perm', 'cambio', { from: prev, to: p.state });
          prev = p.state;
        }
      }).catch(function(){});
    } catch(e){}
  })();

  // ---- Botón "Exportar log" (creado por JS, sin tocar HTML) ----------------------
  function installExportButton(){
    var anchor = document.getElementById('reset-punches');
    if(!anchor || document.getElementById('export-log')) return;
    var btn = document.createElement('button');
    btn.id = 'export-log';
    btn.type = 'button';
    btn.className = anchor.className; // hereda estilo (track-btn off)
    btn.title = 'Exportar log de sesión';
    btn.textContent = '📋 Exportar log';
    btn.style.marginLeft = '6px';
    anchor.insertAdjacentElement('afterend', btn);
    btn.addEventListener('click', onExportClick);
  }
  function onExportClick(){
    var data = AppLogger.export();
    var fname = 'htiryo-log-' + new Date().toISOString().replace(/[:.]/g,'-') + '.ndjson';
    // 1) Web Share API con archivo
    try {
      if(navigator.canShare && typeof File !== 'undefined'){
        var file = new File([data], fname, {type:'application/x-ndjson'});
        if(navigator.canShare({files:[file]})){
          navigator.share({files:[file], title:'HT-Iryo log'}).catch(function(){ fallbackClipboard(); });
          return;
        }
      }
    } catch(e){}
    fallbackClipboard();

    function fallbackClipboard(){
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(data).then(function(){
          try { alert('Log copiado al portapapeles ('+ data.split('\n').length +' entradas)'); } catch(e){}
        }, function(){ fallbackDownload(); });
        return;
      }
      fallbackDownload();
    }
    function fallbackDownload(){
      try {
        var blob = new Blob([data], {type:'application/x-ndjson'});
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click();
        setTimeout(function(){
          try { document.body.removeChild(a); } catch(e){}
          try { URL.revokeObjectURL(url); } catch(e){}
        }, 200);
      } catch(e){}
    }
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', installExportButton);
  } else {
    installExportButton();
  }
})();
