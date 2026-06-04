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
  var POLL_MS    = 30000;  // cada cuánto se ejecuta el ciclo (solo consulta GPS con ventana abierta)
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
  // Filtro de precisión GPS (m). Por encima → no marca, espera mejor señal.
  // 1500m es permisivo a propósito: un AVE a 300 km/h recorre 5 km/min,
  // así que ±1.5 km son ~18 s de error → no afecta a la ventana de marca.
  // Sólo rechaza posiciones realmente malas (Wi-Fi triangulation puede dar
  // varios km de error en interior de túneles).
  var MAX_ACCURACY_M = 1500;
  // Si el GPS reporta que ya pasamos por la parada actual, marcar con hora real.
  // El parámetro `skipped` se mantiene por compatibilidad pero ya NO altera la fuente
  // (antes hacía estimateMark, ahora siempre marca con GPS).
  function autoMark(idx, skipped){
    if(API.getMark(idx) != null && API.getMarkSource(idx) === 'manual'){
      logEvent('conflicto', stName(idx) + ' — marca manual ' + API.getMark(idx) + ' conservada');
      setStatus('Conflicto en ' + stName(idx) + ': marca manual ' + API.getMark(idx) + ' conservada', 'warn');
      windowOpen = false;
      return;
    }
    var now = API.nowMin();
    var hhmm = pad(Math.floor(now/60) % 24) + ':' + pad(Math.floor(now % 60));
    API.setMark(idx, hhmm, 'gps');
    logEvent('paso', stName(idx) + ' ' + hhmm + (skipped ? ' · GPS (saltada en cadena)' : ' · GPS'));
    if(!skipped) setStatus('✓ ' + stName(idx) + ' ' + hhmm + ' (GPS)', 'ok');
    windowOpen = false;
    recomputeNext();
  }

  // Solo se usa cuando el GPS NO responde (timeout/permiso/cobertura): estima la
  // hora con teórica + delta. Marcadas como 'est' para diferenciarlas en HT.
  function estimateMark(idx){
    if(API.getMark(idx) != null && API.getMarkSource(idx) === 'manual'){
      logEvent('conflicto', stName(idx) + ' — marca manual ' + API.getMark(idx) + ' conservada');
      windowOpen = false;
      return;
    }
    var m = API.getMarch();
    var eff = m.s[idx].tm + currentDelta();
    var hhmm = fmtHM(eff);
    API.setMark(idx, hhmm, 'est');
    logEvent('paso', stName(idx) + ' ' + hhmm + ' · estimada (sin GPS)');
    setStatus('~ ' + stName(idx) + ' ' + hhmm + ' (estimada, sin GPS)', 'warn');
    windowOpen = false;
    gpsFailCount = 0;
    recomputeNext();
  }

  // Mapa código de error → mensaje legible para el maquinista.
  function gpsErrorMsg(err){
    if(!err || typeof err.code === 'undefined') return 'Sin señal GPS';
    if(err.code === 1) return '⚠ Permiso de ubicación denegado — revisa ajustes del navegador';
    if(err.code === 2) return '⚠ GPS no disponible — activa la ubicación o sal del túnel';
    if(err.code === 3) return '⏱ GPS lento (>10s) — débil cobertura';
    return 'Error GPS (' + err.code + ')';
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
      else { setStatus('Próxima estación: ' + name + ' · hora prevista ' + fmtHM(eff)); return; }
    }

    // Ventana abierta → consultar el GPS
    GeoSource.getCurrent().then(function(pos){
      if(!tracking) return;
      gpsFailCount = 0;
      // G5: descartar posiciones imprecisas (cellular fallback puede dar 1000-2000m).
      if(pos.accuracy != null && pos.accuracy > MAX_ACCURACY_M){
        setStatus('GPS impreciso (' + Math.round(pos.accuracy) + 'm) — esperando mejor señal', 'warn');
        return;
      }
      var pr = projectGps(pos.lat, pos.lng);
      if(!pr){ logEvent('fuera_ruta', 'GPS fuera de la ruta', 'fuera'); setStatus('GPS fuera de la ruta — ¿tren correcto?', 'warn'); return; }
      if(pr.passedOrigIdx != null && pr.passedOrigIdx >= gpsNextIdx){
        // G2: marcar EN CADENA todas las paradas que el GPS confirma ya pasadas,
        // en lugar de procesar solo una por pollTick (que tardaba 30s/parada).
        // Todas con hora actual y source='gps' (no inventamos teórica).
        var safety = 0;
        while(gpsNextIdx >= 0 && pr.passedOrigIdx >= gpsNextIdx && safety < 50){
          var wasSkipped = pr.passedOrigIdx > gpsNextIdx;
          autoMark(gpsNextIdx, wasSkipped);
          // autoMark llama recomputeNext, actualiza gpsNextIdx
          safety++;
          // Si conflicto manual (autoMark devuelve sin recomputeNext porque setea windowOpen=false),
          // safety previene loop infinito.
        }
      } else {
        if(nowM > eff + 0.5){
          var prov = currentDelta() + (nowM - eff);
          API.setProvisionalDelay(prov);
          logEvent('retraso', '+' + Math.round(prov) + ' min provisional hacia ' + name, 'retraso' + Math.round(prov));
          setStatus('Retraso creciendo: +' + fmtDur(prov) + ' · sin pasar aún ' + name, 'warn');
        } else {
          API.setProvisionalDelay(null);
          setStatus('En ruta hacia ' + name + ' (previsto ' + fmtHM(eff) + ')');
        }
      }
    }).catch(function(err){
      if(!tracking) return;
      gpsFailCount++;
      var eff2 = effTime(gpsNextIdx);
      var giveUp = (normNow(eff2) >= eff2 + GIVEUP_MIN);
      if(giveUp){
        estimateMark(gpsNextIdx);
      } else {
        var msg = gpsErrorMsg(err);
        logEvent('sin_senal', msg + ' cerca de ' + name, 'sinsenal' + (err && err.code));
        setStatus(msg + ' · cerca de ' + name, 'warn');
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
    logEvent('inicio', 'Seguimiento iniciado · ' + (m.t || '') + ' ' + (m.o || '') + '→' + (m.d || ''));
    requestWakeLock();
    // Sonda de permiso dentro del gesto del usuario.
    GeoSource.getCurrent().then(function(pos){
      var acc = pos.accuracy != null ? ' (precisión ' + Math.round(pos.accuracy) + 'm)' : '';
      setStatus('GPS activo — seguimiento iniciado' + acc, 'ok');
    }).catch(function(err){
      setStatus(gpsErrorMsg(err), 'warn');
    });
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollTick, POLL_MS);
    updateButton();
    pollTick();
  }

  function stopTracking(){
    if(tracking) logEvent('fin', 'Seguimiento detenido');
    tracking = false; windowOpen = false;
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
    releaseWakeLock();
    hideAction();
    if(API.setProvisionalDelay) API.setProvisionalDelay(null);
    setStatus('Seguimiento detenido');
    updateButton();
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
  // La UI del GPS vive ahora en la cabecera del Horario (index.html):
  //  - botón #gps-btn en .top-row
  //  - sublínea #gps-subline dentro del recuadro de posición
  function buildUI(){
    el.btn     = document.getElementById('gps-btn');
    el.subline = document.getElementById('gps-subline');
    if(el.btn){
      el.btn.addEventListener('click', function(){
        if(tracking) stopTracking(); else startTracking();
      });
    }
  }

  function setStatus(text, cls){
    if(!el.subline) return;
    el.subline.textContent = text || '';
    el.subline.className = cls || '';
    if(API.refreshPositionBox) API.refreshPositionBox();
  }

  // Estado con acción tocable (p. ej. "Reactivar localización") en la sublínea.
  function showAction(label, fn){
    if(!el.subline) return;
    el.subline.textContent = '';
    el.subline.className = 'warn';
    var a = document.createElement('span');
    a.className = 'gps-act';
    a.textContent = label;
    a.onclick = fn;
    el.subline.appendChild(a);
    if(API.refreshPositionBox) API.refreshPositionBox();
  }
  function hideAction(){
    if(!el.subline) return;
    el.subline.textContent = '';
    el.subline.className = '';
    if(API.refreshPositionBox) API.refreshPositionBox();
  }

  function fmtTime(){ return new Date().toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

  // ===== Registro automático del recorrido (Mejora 2) ========================
  // Se graba solo, sin botones, mientras el seguimiento está activo: una entrada
  // por cada marca y por cada evento, en localStorage['ebula_gpslog_v1'],
  // indexado por marcha (tickKey). Sin pantalla ni exportación (de momento).
  var LOG_KEY = 'ebula_gpslog_v1';
  var lastLogSig = '';
  function logEvent(tipo, detalle, dedup){
    try{
      if(dedup){
        var sig = tipo + '|' + dedup;
        if(sig === lastLogSig) return;   // no repetir el mismo evento en cada sondeo
        lastLogSig = sig;
      } else {
        lastLogSig = '';
      }
      var store = JSON.parse(localStorage.getItem(LOG_KEY) || '{}');
      var key = (API.getTickKey && API.getTickKey()) || 'marcha';
      if(!store[key]) store[key] = [];
      store[key].push({ t: fmtTime(), tipo: tipo, detalle: detalle == null ? '' : String(detalle) });
      if(store[key].length > 600) store[key] = store[key].slice(-600);
      localStorage.setItem(LOG_KEY, JSON.stringify(store));
    }catch(e){}
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

  // ===== Eventos =============================================================
  document.addEventListener('visibilitychange', function(){
    if(document.hidden){
      if(tracking) hadHidden = true;
    } else if(tracking){
      requestWakeLock();
      if(hadHidden){
        hadHidden = false;
        showAction('⚠ En 2.º plano: el seguimiento pudo pausarse — toca para reactivar', function(){
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
    if(API.setProvisionalDelay) API.setProvisionalDelay(null);
    setStatus('Seguimiento GPS inactivo');
    checkDeparture();
  });

  // ===== Inicio ==============================================================
  // El horario consulta esto para no extrapolar la posición por reloj cuando
  // el seguimiento GPS está activo.
  API.isTracking = function(){ return tracking; };
  // Registra en el log una marca hecha a mano (la llama index.html desde punchAt).
  API.logManualMark = function(idx){ logEvent('paso', stName(idx) + ' · manual'); };
  buildUI();
  checkDeparture();
  armTimer = setInterval(checkDeparture, 20000);
})();
