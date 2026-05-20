/* HT Iryo — Seguimiento GPS de la marcha
 * Módulo independiente. Toda la lógica de localización vive aquí; index.html
 * solo expone la API window.HTIryo.
 *
 * Funcionamiento (v1): el GPS NO vigila entre estaciones. Cerca de cada estación
 * se abre una "ventana" calculada con la hora efectiva (teórica + retraso/adelanto
 * acumulado); dentro de la ventana se sondea el GPS, se proyecta la posición sobre
 * la ruta de la marcha y, al detectar el paso, se registra la hora real. Si no hay
 * señal GPS, se rellena con hora estimada.
 */
(function(){
  'use strict';

  var API = window.HTIryo;
  if(!API){ console.warn('[GPS] API HTIryo no disponible — módulo desactivado'); return; }

  // ---- Parámetros ----
  var POLL_MS    = 15000;  // cada cuánto se ejecuta el ciclo (solo consulta GPS con ventana abierta)
  var LEAD_MIN   = 2;      // minutos antes de la hora efectiva en que se abre la ventana
  var GIVEUP_MIN = 3;      // minutos tras la hora efectiva sin señal → rellenar con estimada
  var OFF_ROUTE  = 1e-3;   // umbral de "fuera de ruta" (distancia² en grados; ~3 km)
  var ARM_LEAD   = 3;      // minutos antes de la salida en que aparece el aviso de arranque

  // ---- Estado ----
  var tracking   = false;
  var windowOpen = false;
  var armed      = false;
  var gpsNextIdx = -1;
  var gpsFailCount = 0;
  var pollTimer  = null;
  var armTimer   = null;
  var wakeLock   = null;
  var hadHidden  = false;
  var el = {};

  /* ===== Capa de geolocalización aislada =====================================
   * Para migrar a Capacitor en el futuro, basta sustituir este objeto por una
   * implementación con @capacitor/geolocation. El resto del módulo no cambia.
   */
  var GeoSource = {
    getCurrent: function(){
      return new Promise(function(resolve, reject){
        if(!navigator.geolocation){ reject(new Error('sin geolocalización')); return; }
        navigator.geolocation.getCurrentPosition(
          function(p){ resolve({ lat:p.coords.latitude, lng:p.coords.longitude, accuracy:p.coords.accuracy }); },
          function(err){ reject(err); },
          { enableHighAccuracy:true, timeout:10000, maximumAge:0 }
        );
      });
    }
  };

  // ===== Utilidades ==========================================================
  function pad(n){ n = Math.floor(n); return (n < 10 ? '0' : '') + n; }
  function fmtHM(min){ min = ((Math.round(min) % 1440) + 1440) % 1440; return pad(min/60) + ':' + pad(min%60); }
  function fmtDur(min){ return Math.floor(Math.abs(min)) + ' min'; }

  function stName(idx){
    var m = API.getMarch();
    if(!m || !m.s[idx]) return '?';
    return m.s[idx].n || ('PK ' + m.s[idx].k);
  }

  // ¿Es una fila que el GPS debe seguir? Estación con nombre, coordenada y hora
  // teórica; se excluye el origen (idx 0) y las dependencias BCE/CDI.
  function isMarkable(m, i){
    var s = m.s[i];
    return !!(i > 0 && s && s.n && API.COORDS[s.n] && s.tm != null && !s._l010cdi);
  }

  // Retraso (+) / adelanto (−) actual en minutos, a partir de la última marca.
  function currentDelta(){
    var m = API.getMarch();
    if(!m) return 0;
    var lp = -1;
    for(var i = 0; i < m.s.length; i++){
      if(m.s[i] && m.s[i].tm != null && API.getMark(i) != null) lp = i;
    }
    if(lp < 0) return 0;
    var mk = String(API.getMark(lp)).split(':');
    var diff = ((+mk[0]) * 60 + (+mk[1])) - m.s[lp].tm;
    if(diff < -720) diff += 1440;
    if(diff >  720) diff -= 1440;
    return diff;
  }

  // Hora efectiva (minutos) prevista para una estación = teórica + delta.
  function effTime(idx){
    var m = API.getMarch();
    return m.s[idx].tm + currentDelta();
  }

  // Hora actual normalizada para comparar con una hora efectiva (cruce de medianoche).
  function normNow(eff){
    var n = API.nowMin();
    while(eff - n > 720) n += 1440;
    while(n - eff > 720) n -= 1440;
    return n;
  }

  // Primera estación seguible aún sin marcar.
  function recomputeNext(){
    var m = API.getMarch();
    gpsNextIdx = -1;
    if(!m) return;
    for(var i = 1; i < m.s.length; i++){
      if(isMarkable(m, i) && API.getMark(i) == null){ gpsNextIdx = i; return; }
    }
  }

  /* Proyecta una posición GPS sobre la ruta de la marcha.
   * Devuelve { passedOrigIdx } = índice (en march.s) de la última dependencia
   * superada, o null si la posición está fuera de la ruta. */
  function projectGps(lat, lng){
    var m = API.getMarch();
    if(!m) return null;
    var path = API.getPath(m);
    if(!path || !path.length) return null;

    // Mapa: índice en la lista filtrada (la que usa buildMarchaPath) → índice en march.s
    var filtOrig = [];
    for(var i = 0; i < m.s.length; i++){
      if(m.s[i].n && API.COORDS[m.s[i].n]) filtOrig.push(i);
    }

    var best = null;
    for(var si = 0; si < path.length; si++){
      var seg = path[si];
      var snap = API.snapToPolyline([lat, lng], seg.segPath);
      if(!best || snap.dist < best.dist){ best = { dist:snap.dist, seg:seg, snap:snap }; }
    }
    if(!best || best.dist > OFF_ROUTE) return null;

    var seg = best.seg;
    var nearEnd = (best.snap.idx >= seg.segPath.length - 2 && best.snap.t > 0.6);
    var passedFilt = nearEnd ? seg.toIdx : seg.fromIdx;
    return { passedOrigIdx: filtOrig[passedFilt], distDeg2: best.dist };
  }

  // ===== Registro de marcas ==================================================
  function autoMark(idx, skipped){
    // Conflicto: la estación ya tiene marca manual → conservarla y avisar.
    if(API.getMark(idx) != null && API.getMarkSource(idx) === 'manual'){
      setStatus('Conflicto en ' + stName(idx) + ': marca manual ' + API.getMark(idx) + ' conservada', 'warn');
      windowOpen = false;
      return;
    }
    if(skipped){ estimateMark(idx); return; }
    var now = API.nowMin();
    var hhmm = pad(Math.floor(now/60) % 24) + ':' + pad(Math.floor(now % 60));
    API.setMark(idx, hhmm, 'gps');
    setStatus('✓ ' + stName(idx) + ' ' + hhmm + ' (GPS)', 'ok');
    windowOpen = false;
    recomputeNext();
  }

  function estimateMark(idx){
    var m = API.getMarch();
    var eff = m.s[idx].tm + currentDelta();
    var hhmm = fmtHM(eff);
    API.setMark(idx, hhmm, 'est');
    setStatus('~ ' + stName(idx) + ' ' + hhmm + ' (estimada, sin GPS)', 'warn');
    windowOpen = false;
    gpsFailCount = 0;
    recomputeNext();
  }

  // ===== Ciclo principal =====================================================
  function pollTick(){
    if(!tracking) return;
    recomputeNext();
    if(gpsNextIdx < 0){ setStatus('Marcha completada', 'ok'); return; }

    var name = stName(gpsNextIdx);
    var eff  = effTime(gpsNextIdx);
    var nowM = normNow(eff);

    if(!windowOpen){
      if(nowM >= eff - LEAD_MIN){ windowOpen = true; gpsFailCount = 0; }
      else { setStatus('Esperando ' + name + ' · ventana ~' + fmtHM(eff - LEAD_MIN)); return; }
    }

    // Ventana abierta → consultar el GPS
    GeoSource.getCurrent().then(function(pos){
      if(!tracking) return;
      gpsFailCount = 0;
      var pr = projectGps(pos.lat, pos.lng);
      if(!pr){ setStatus('GPS fuera de la ruta — ¿tren correcto?', 'warn'); return; }
      if(pr.passedOrigIdx != null && pr.passedOrigIdx >= gpsNextIdx){
        autoMark(gpsNextIdx, pr.passedOrigIdx > gpsNextIdx);
      } else {
        var late = nowM - eff;
        if(late > 0.5) setStatus('Esperando paso por ' + name + ' · +' + fmtDur(late) + ' retraso', 'warn');
        else setStatus('En ruta hacia ' + name);
      }
    }).catch(function(){
      if(!tracking) return;
      gpsFailCount++;
      var eff2 = effTime(gpsNextIdx);
      if(normNow(eff2) >= eff2 + GIVEUP_MIN){
        estimateMark(gpsNextIdx);
      } else {
        setStatus('Sin señal GPS cerca de ' + name + '…', 'warn');
      }
    });
  }

  // ===== Arranque / parada ===================================================
  function startTracking(){
    if(tracking) return;
    var m = API.getMarch();
    if(!m){ setStatus('No hay marcha seleccionada', 'warn'); return; }
    tracking = true; windowOpen = false; gpsFailCount = 0; armed = false;
    recomputeNext();
    requestWakeLock();
    // Sonda de permiso dentro del gesto del usuario.
    GeoSource.getCurrent().then(function(){
      setStatus('GPS activo — seguimiento iniciado', 'ok');
    }).catch(function(){
      setStatus('Permiso de ubicación denegado o sin señal', 'warn');
    });
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollTick, POLL_MS);
    updateButton(); updateBarVisibility();
    pollTick();
  }

  function stopTracking(){
    tracking = false; windowOpen = false;
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
    releaseWakeLock();
    hideAction();
    setStatus('Seguimiento detenido');
    updateButton(); updateBarVisibility();
  }

  // ===== Wake Lock (mantener la pantalla encendida) ==========================
  function requestWakeLock(){
    try{
      if('wakeLock' in navigator){
        navigator.wakeLock.request('screen').then(function(wl){
          wakeLock = wl;
          wakeLock.addEventListener('release', function(){ wakeLock = null; });
        }).catch(function(){
          setStatus('No se pudo mantener la pantalla encendida', 'warn');
        });
      }
    }catch(e){}
  }
  function releaseWakeLock(){
    if(wakeLock){ try{ wakeLock.release(); }catch(e){} wakeLock = null; }
  }

  // ===== Aviso de arranque por hora de salida ================================
  function checkDeparture(){
    if(tracking) return;
    var m = API.getMarch();
    if(!m || !m.s.length || !m.s[0].h){ armed = false; updateButton(); return; }
    var p = m.s[0].h.split(':');
    var depMin = (+p[0]) * 60 + (+p[1]);
    var diff = API.nowMin() - depMin;
    if(diff < -720) diff += 1440;
    if(diff >  720) diff -= 1440;
    armed = (diff >= -ARM_LEAD);   // desde ARM_LEAD min antes de la salida
    updateButton();
  }

  // ===== Interfaz ============================================================
  function buildUI(){
    var st = document.createElement('style');
    st.textContent =
      '#gps-bar{position:fixed;left:10px;bottom:10px;z-index:950;display:none;' +
        'align-items:center;gap:8px;max-width:min(92vw,540px);' +
        'background:var(--panel,#161b22);border:1px solid var(--border,#30363d);' +
        'border-radius:8px;padding:6px 10px;box-shadow:0 4px 16px rgba(0,0,0,.45);' +
        'font-family:Inter,sans-serif;font-size:12px}' +
      '#gps-bar.visible{display:flex}' +
      '#gps-status{color:var(--fg-dim,#9ba3ad);white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;flex:1;min-width:0}' +
      '#gps-status.warn{color:var(--warn,#f0883e)}' +
      '#gps-status.ok{color:var(--ok,#3fb950)}' +
      '#gps-bar button{cursor:pointer;border-radius:5px;padding:5px 9px;font-size:12px;' +
        'font-weight:600;font-family:inherit;border:1px solid var(--border,#30363d);' +
        'background:var(--panel-2,#1f242c);color:var(--fg,#e6edf3);white-space:nowrap}' +
      '#gps-btn.tracking{background:#3a1d1d;border-color:#f85149;color:#f85149}' +
      '#gps-btn.armed{background:#0d2818;border-color:#3fb950;color:#3fb950;' +
        'animation:gpsPulse 1.6s infinite}' +
      '#gps-action{background:#0d2818;border-color:#3fb950;color:#3fb950}' +
      '@keyframes gpsPulse{0%,100%{opacity:1}50%{opacity:.5}}';
    document.head.appendChild(st);

    var bar = document.createElement('div');
    bar.id = 'gps-bar';
    bar.innerHTML =
      '<span id="gps-status">Seguimiento GPS inactivo</span>' +
      '<button id="gps-action" hidden type="button"></button>' +
      '<button id="gps-btn" type="button">▶ Iniciar seguimiento GPS</button>';
    document.body.appendChild(bar);

    el.bar    = bar;
    el.status = bar.querySelector('#gps-status');
    el.action = bar.querySelector('#gps-action');
    el.btn    = bar.querySelector('#gps-btn');

    el.btn.addEventListener('click', function(){
      if(tracking) stopTracking(); else startTracking();
    });
  }

  function setStatus(text, cls){
    if(!el.status) return;
    el.status.textContent = text;
    el.status.className = cls || '';
  }

  function showAction(label, fn){
    if(!el.action) return;
    el.action.textContent = label;
    el.action.hidden = false;
    el.action.onclick = fn;
  }
  function hideAction(){
    if(!el.action) return;
    el.action.hidden = true;
    el.action.onclick = null;
  }

  function updateButton(){
    if(!el.btn) return;
    el.btn.classList.remove('tracking', 'armed');
    if(tracking){
      el.btn.textContent = '■ Parar seguimiento';
      el.btn.classList.add('tracking');
    } else if(armed){
      el.btn.textContent = '● Hora de salida — Iniciar seguimiento';
      el.btn.classList.add('armed');
    } else {
      el.btn.textContent = '▶ Iniciar seguimiento GPS';
    }
  }

  function updateBarVisibility(){
    if(!el.bar) return;
    var onSchedule = document.body.classList.contains('tab-schedule');
    el.bar.classList.toggle('visible', onSchedule || tracking);
  }

  // ===== Eventos =============================================================
  document.addEventListener('click', function(e){
    var t = e.target.closest && e.target.closest('.tab, .home-btn');
    if(t) setTimeout(updateBarVisibility, 60);
  });

  document.addEventListener('visibilitychange', function(){
    if(document.hidden){
      if(tracking) hadHidden = true;
    } else if(tracking){
      requestWakeLock();
      if(hadHidden){
        hadHidden = false;
        setStatus('La app estuvo en segundo plano — el seguimiento pudo pausarse', 'warn');
        showAction('Reactivar localización', function(){
          hideAction();
          requestWakeLock();
          pollTick();
          setStatus('Localización reactivada', 'ok');
        });
      }
    }
  });

  API.onMarchaChange(function(){
    if(tracking) stopTracking();
    windowOpen = false; gpsNextIdx = -1; armed = false;
    hideAction();
    setStatus('Seguimiento GPS inactivo');
    checkDeparture();
    updateBarVisibility();
  });

  // ===== Inicio ==============================================================
  buildUI();
  checkDeparture();
  armTimer = setInterval(checkDeparture, 20000);
  updateBarVisibility();
})();
