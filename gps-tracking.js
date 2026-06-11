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
  var POLL_MS       = 30000;  // intervalo normal (ventana cerrada o ventana abierta sin fallos)
  var POLL_MS_FAST  = 15000;  // intervalo rápido cuando hubo ≥1 fallo en la ventana actual
  var LEAD_MIN      = 2;      // minutos antes de la hora efectiva en que se abre la ventana
  var GIVEUP_MIN    = 3;      // minutos tras la hora efectiva sin señal → rellenar con estimada (base)
  var GIVEUP_MAX    = 5;      // cap del GIVEUP adaptativo (3 + gpsFailCount, máx GIVEUP_MAX)
  var OFF_ROUTE     = 1e-3;   // umbral de "fuera de ruta" (distancia² en grados; ~3 km)
  var ARM_LEAD      = 3;      // minutos antes de la salida en que aparece el aviso de arranque

  // ---- Parámetros CPA (Bloque 2) ----
  var CPA_HISTORY_MAX = 6;            // lecturas guardadas para detectar mínimo (6 para que el mínimo
                                       // sobreviva varias lecturas en aproximaciones lentas)
  var CPA_STALE_MS    = 5 * 60 * 1000; // > 5 min sin lectura → historial inservible (background largo)
  var CPA_NEAR_M      = 100;          // mitigación B: una sola lectura tan cerca → marca con ella
  var CPA_GAP_MS      = 30 * 1000;     // mitigación A: hueco entre 2 lecturas que supera 30 s → interpolar
  var CPA_CONFIRM_MAX_M = 1000;        // puerta de distancia: el mínimo debe estar a < 1 km de la estación
                                       // para confirmar paso. Evita falsos CPA por jitter GPS lejos de la
                                       // estación (p. ej. tren casi parado a 3 km con ±30 m de ruido).
  var CPA_GAP_MAX_M     = 3000;        // mitigación A (hueco/túnel): la lectura más cercana puede estar
                                       // hasta a 3 km (túneles largos); la interpolación sigue siendo válida.
  var CPA_RISE_MIN_M    = 50;          // la subida sobre el mínimo debe superar max(50 m, accuracy) para
                                       // descartar que sea ruido de la propia lectura.

  // ---- Parámetros sondeo adaptativo (Bloque 1) ----
  var POLL_MIN_MS       = 2000;     // sondeo no baja de 2 s (acercamiento final)
  var POLL_LEAD_S       = 15;       // anticipación de la fórmula: (dist/v) - 15 s
  var POLL_SPEED_MIN_MS = 0.5;      // si la velocidad reportada es < 0.5 m/s (≈ parado), fallback fijo
  var LTV_FAR_THRESHOLD_M = 5000;   // primera lectura > 5 km al abrir ventana → mitigación DHLTV

  // ---- Parámetros detector de parado (Bloque 4) ----
  var STOP_SPEED_MAX_MS         = 0.83;        // ≈ 3 km/h: por debajo cuenta como "lectura lenta"
  var STOP_CONFIRM_MIN_MS       = 90 * 1000;   // 90 s con lecturas lentas → confirma PARADO
  var STOP_CONFIRM_MIN_READINGS = 3;           // y al menos 3 lecturas en ese intervalo
  var STOP_BUFFER_MAX           = 10;          // FIFO de lecturas lentas. BUG-FIX: antes se capaba a 3,
                                               // pero 3 lecturas a cadencia 30 s abarcan solo 60 s y la
                                               // condición de 90 s no se cumplía NUNCA (Bloque 4 muerto).
  var STOP_EXIT_DIST_M          = 50;          // movimiento > 50 m desde stoppedAtLat/Lng → arranque
  var STOP_COARSE_DIST_M        = 30;          // respaldo coarse: lecturas a < 30 m entre sí = quieto
  var STOP_COARSE_MAX_ACC_M     = 500;         // respaldo coarse: accuracy peor → no evaluar quietud
  var POLL_INFLIGHT_MAX_MS      = 20000;       // watchdog: cerrojo en vuelo > 20 s → liberarlo (promesa
                                               // que nunca resuelve tras background en algunos Android)

  // ---- Parámetros antenas + verif satelital en PARADO (Bloque 4A) ----
  var SAT_VERIFY_INTERVAL_MS    = 180 * 1000;  // 3 min: cada cuánto comprobar con satélite durante PARADO
  var SAT_VERIFY_EXIT_DIST_M    = 1000;        // verif satelital muestra > 1 km → arranque (movimiento real)
  var ANTENNA_ACCURACY_IGNORE_M = 1000;        // callback de antena con accuracy peor → ignorar
  var ANTENNA_DRIFT_CONSEC      = 2;           // 2 callbacks consecutivos > 50 m → arranque (anti-jitter)

  // ---- Parámetros arranque inteligente (Bloque 4B) ----
  var COLD_START_DEFER_MIN      = 5;   // tiempo a ventana ≥ este → diferir, solo antenas
  var COLD_START_PROBE_LEAD_MIN = 5;   // anticipación del cold start respecto a apertura de ventana

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

  // ---- Estado CPA (Bloque 2) ----
  var cpaTarget  = -1;   // idx de la estación cuya distancia se está siguiendo
  var cpaHistory = [];   // [{ts, distM, lat, lng, speedMs}, ...] FIFO de hasta CPA_HISTORY_MAX

  // ---- Estado sondeo adaptativo (Bloque 1) ----
  var lastFineReading = null;   // { ts, distM, speedMs } de la última lectura fine — usado por schedulePoll
  var ltvWait = false;          // primera lectura de la ventana mostró > 5 km → mitigación DHLTV
  var pollInFlight = false;     // cerrojo: hay un getCurrentPosition de pollTick en vuelo (anti-solape)
  var pollInFlightSince = 0;    // ms del lanzamiento — watchdog contra promesas que nunca resuelven
  var pollSeq = 0;              // token de secuencia: una resolución zombi (superada por el watchdog)
                                // se descarta comparando su token con el actual

  // ---- Estado detector de parado (Bloque 4) ----
  var isStopped       = false;  // PARADO confirmado (3 lect lentas en 90 s) — bloquea estimateMark/catchUp
  var stoppedSince    = 0;      // ms del instante en que se confirmó PARADO
  var stoppedAtIdx    = -1;     // idx de la estación destino al entrar (para logEvent y status)
  var stoppedAtLat    = 0;      // posición de referencia para detectar movimiento de salida
  var stoppedAtLng    = 0;
  var slowReadings    = [];     // FIFO lecturas lentas (fine) para promoción a PARADO (cap STOP_BUFFER_MAX)
  var coarseStill     = [];     // respaldo del plan: lecturas coarse consecutivas a < 30 m entre sí
                                // (zonas sin GPS satelital, donde el criterio fine queda ciego)

  // ---- Estado antenas + verif satelital (Bloque 4A) ----
  var watchId            = null; // handle del watchPosition (compartido 4A/4B, sin solapamiento)
  var satCheckTimer      = null; // setTimeout id de la próxima verif satelital
  var satCheckInFlight   = false;// cerrojo: hay un getCurrentPosition de verif en vuelo
  var satCheckInFlightSince = 0; // watchdog del cerrojo de verif (mismo riesgo de promesa colgada)
  var antennaDriftCount  = 0;    // contador anti-jitter de callbacks de antena

  // ---- Estado arranque inteligente (Bloque 4B) ----
  var preWindowDeferred  = false; // tracking iniciado pero GPS pospuesto hasta cerca de la 1ª ventana
  var coldStartTimer     = null;  // setTimeout id del momento de activar el chip GPS

  /* ===== Capa de geolocalización aislada =====================================
   * Para migrar a Capacitor en el futuro, basta sustituir este objeto por una
   * implementación con @capacitor/geolocation. El resto del módulo no cambia.
   */
  var GeoSource = {
    getCurrent: function(){
      return new Promise(function(resolve, reject){
        if(!navigator.geolocation){ reject(new Error('sin geolocalización')); return; }
        navigator.geolocation.getCurrentPosition(
          function(p){ resolve({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: p.coords.accuracy,
            heading: p.coords.heading,   // null si parado o si la fuente no lo da (coarse fix)
            speed: p.coords.speed        // null si la fuente no lo da (cellular) — usado por isFineFix
          }); },
          function(err){ reject(err); },
          { enableHighAccuracy:true, timeout:10000, maximumAge:0 }
        );
      });
    },
    // watch: el navegador notifica cuando la posición cambia, sin coste del chip
    // GPS (lo aporta la red celular). Usado por Bloque 4A durante PARADO para
    // ahorrar batería: el watchPosition queda dormido hasta que la antena
    // detecta movimiento del tren.
    watchStart: function(onPos, onErr){
      if(!navigator.geolocation) return null;
      return navigator.geolocation.watchPosition(
        function(p){ onPos({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          heading: p.coords.heading,
          speed: p.coords.speed
        }); },
        function(err){ if(onErr) onErr(err); },
        { enableHighAccuracy:false, timeout:30000, maximumAge:60000 }
      );
    },
    watchStop: function(id){
      if(id != null && navigator.geolocation) navigator.geolocation.clearWatch(id);
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

  // ===== Filtros de calidad de lectura (Bloque 3) ============================
  // Distingue GPS satelital ("fine fix") de triangulación celular/Wi-Fi ("coarse fix").
  //  - Fine fix: el navegador entrega `speed` (m/s, puede ser 0 si parado).
  //  - Coarse fix: viene de antenas; speed = null. El accuracy reportado en
  //    coarse fix es optimista — el error físico real puede ser 5–10× mayor.
  // Solo fine fix con accuracy proporcionada a la velocidad puede marcar
  // estaciones; coarse fix se usa como información de contexto, no para marcar.
  var TRACKING_ACCURACY_M = 1500;   // umbral absoluto: por encima, basura para cualquier uso

  function isFineFix(pos){
    // speed != null indica fuente satelital. heading puede ser null legítimamente
    // cuando el tren está parado (sin vector de movimiento), por eso NO se exige.
    return pos != null && pos.speed != null;
  }

  // Accuracy máxima admitida para MARCAR, según velocidad del tren (km/h).
  // A 300 km/h el tren recorre 83 m/s — un accuracy de 100 m + latencia GPS
  // (~150 m) da ±250 m de error físico, ya inaceptable. A baja velocidad,
  // el accuracy se traduce directamente en error sin amplificación temporal.
  function accuracyThresholdForSpeed(speedKmh){
    if(speedKmh > 200) return 50;    // crucero LAV
    if(speedKmh > 50)  return 100;   // aproximación
    if(speedKmh >= 3)  return 200;   // entrada de andén
    return 500;                       // parado
  }

  // ===== CPA — Closest Point of Approach (Bloque 2) ==========================
  // Detecta el paso por una estación midiendo la distancia geodésica real
  // tren→estación a lo largo de varias lecturas. Cuando la distancia deja de
  // bajar y empieza a subir, el momento más cercano físico ya ocurrió.
  // Más preciso que el criterio geométrico (snap.t > 0.6 sobre un trozo de
  // polyline) porque no depende de la posición de los vértices del mapa.

  // Haversine: distancia en metros entre dos puntos lat/lng sobre la esfera
  // (radio medio 6371 km). Más exacto que la euclidiana plana del snapToPolyline
  // para distancias > ~1 km y latitudes peninsulares.
  function haversineMeters(lat1, lng1, lat2, lng2){
    var R = 6371000;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1*toRad) * Math.cos(lat2*toRad) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  function cpaResetHistory(targetIdx){
    cpaTarget = (targetIdx == null ? -1 : targetIdx);
    cpaHistory = [];
  }

  function cpaUpdateHistory(distM, pos, nowMs){
    // Cambio de estación destino → empezar de cero (la historia anterior pertenece
    // a otra estación).
    if(cpaTarget !== gpsNextIdx) cpaResetHistory(gpsNextIdx);
    // Hueco > 5 min (background largo, túnel kilométrico): la última entrada es
    // demasiado vieja para ser una "anterior" válida de un mínimo.
    var last = cpaHistory[cpaHistory.length - 1];
    if(last && (nowMs - last.ts) > CPA_STALE_MS) cpaHistory = [];
    cpaHistory.push({ ts: nowMs, distM: distM, lat: pos.lat, lng: pos.lng,
                      speedMs: pos.speed, accM: pos.accuracy });
    if(cpaHistory.length > CPA_HISTORY_MAX) cpaHistory.shift();
  }

  // Examina el historial y decide si la estación destino ya quedó atrás.
  // Devuelve { passed, atMs, via } donde:
  //  - 'cpa'      = mínimo local confirmado en el historial → paso confirmado.
  //  - 'cpa-gap'  = hueco > 30 s rodeando al mínimo (túnel/background) →
  //                 interpolación ponderada (mitigación A).
  //  - 'cpa-near' = 1 sola lectura con dist < 100 m → marca con ella (mitigación B).
  //
  // BUG-FIX respecto a la versión anterior (que solo miraba las 3 últimas entradas):
  //  1. El mínimo se busca en TODO el historial → la mitigación A funciona también
  //     cuando hay lecturas de aproximación previas al túnel (el caso real del
  //     escenario B: n≥3 con hueco). Antes solo se interpolaba con exactamente 2
  //     entradas y el túnel con historial previo marcaba con p2.ts (~800 m de error).
  //  2. Puerta de distancia (CPA_CONFIRM_MAX_M): un mínimo a 3 km de la estación no
  //     confirma paso. Evita falsos positivos por jitter GPS con el tren casi parado
  //     dentro de la ventana (3005 → 2998 → 3010 m habría disparado antes).
  //  3. Puerta de ruido (CPA_RISE_MIN_M / accuracy): la subida tras el mínimo debe
  //     superar el ruido de la lectura. En aproximaciones lentas el mínimo se
  //     confirma unas lecturas más tarde, pero atMs sigue siendo el del mínimo
  //     real, así que la precisión de la marca no se degrada.
  function cpaDetectPass(){
    var n = cpaHistory.length;
    if(n === 0) return { passed: false };
    if(n === 1){
      if(cpaHistory[0].distM < CPA_NEAR_M){
        return { passed: true, atMs: cpaHistory[0].ts, via: 'cpa-near' };
      }
      return { passed: false };
    }
    if(n === 2){
      var a = cpaHistory[0], b = cpaHistory[1];
      if((b.ts - a.ts) > CPA_GAP_MS && b.distM > a.distM && a.distM < CPA_GAP_MAX_M &&
         a.speedMs != null && b.speedMs != null){
        // Ponderación por distancia inversa: el mínimo cae más cerca de la lectura
        // que tenía menor distancia. atMs ∈ [a.ts, b.ts].
        var atMs2 = (a.ts * b.distM + b.ts * a.distM) / (a.distM + b.distM);
        return { passed: true, atMs: atMs2, via: 'cpa-gap' };
      }
      return { passed: false };
    }
    // n >= 3: localizar el mínimo de distancia en todo el historial.
    var minI = 0;
    for(var i = 1; i < n; i++){
      if(cpaHistory[i].distM < cpaHistory[minI].distM) minI = i;
    }
    if(minI === n - 1) return { passed: false };   // el mínimo es la última lectura → aún acercándose
    var minE  = cpaHistory[minI];
    var after = cpaHistory[minI + 1];
    var lastE = cpaHistory[n - 1];
    // ¿Hueco grande justo tras el mínimo? (túnel en boca de estación con historial previo)
    var bigGap  = (after.ts - minE.ts) > CPA_GAP_MS;
    var maxDist = bigGap ? CPA_GAP_MAX_M : CPA_CONFIRM_MAX_M;
    if(minE.distM >= maxDist) return { passed: false };          // puerta de distancia
    // Puerta de ruido: solo para el mínimo "normal" (lecturas densas). Con hueco
    // grande basta subida estricta — es el criterio original de la mitigación A:
    // tras > 30 s a velocidad de línea el tren ha recorrido km, y el jitter no
    // puede fingir esa subida; exigir 50 m bloquearía el caso simétrico del túnel
    // (800 m antes / 800 m después) y la marca caería a 'est' sin necesidad.
    var noise = bigGap ? 0 : Math.max(CPA_RISE_MIN_M, lastE.accM || 0);
    if(lastE.distM - minE.distM <= noise) return { passed: false }; // aún no confirmado
    if(bigGap){
      var atMs3 = (minE.ts * after.distM + after.ts * minE.distM) / (minE.distM + after.distM);
      return { passed: true, atMs: atMs3, via: 'cpa-gap' };
    }
    return { passed: true, atMs: minE.ts, via: 'cpa' };
  }

  // Convierte un timestamp ms a HH:MM (hora local del navegador).
  // Usado por autoMark cuando el paso se determinó en una lectura pasada (CPA).
  function fmtHMfromMs(ts){
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ===== Detector de "tren parado" (Bloque 4) ================================
  // Estado PARADO: el GPS confirma que el tren no se mueve. Mientras dura,
  // se bloquea estimateMark/catchUp para evitar marcar estaciones como pasadas
  // cuando físicamente seguimos donde estábamos. Salida cuando una lectura fine
  // muestra velocidad > 3 km/h o posición desplazada > 50 m.

  function enterStoppedMode(lat, lng, nowMs){
    isStopped     = true;
    stoppedSince  = nowMs;
    stoppedAtIdx  = gpsNextIdx;
    stoppedAtLat  = lat;
    stoppedAtLng  = lng;
    slowReadings  = [];
    coarseStill   = [];
    antennaDriftCount = 0;
    logEvent('parado', 'tren detenido cerca de ' + stName(gpsNextIdx));
    setStatus('Tren detenido — esperando arranque (cerca de ' + stName(gpsNextIdx) + ')', 'warn');
    // Bloque 4A: cortar el ciclo de getCurrentPosition y dejar las antenas
    // escuchando. El chip GPS queda apagado mientras el watch no detecte movimiento.
    if(pollTimer){ clearTimeout(pollTimer); pollTimer = null; }
    if(watchId == null) watchId = GeoSource.watchStart(onAntennaReading);
    // D3: solo programar la verif satelital si hay geolocalización (watchStart
    // devuelve null si no la hay). Sin esto, en un dispositivo sin GPS la verif
    // entraría en bucle fallo→reprograma cada 3 min indefinidamente.
    if(watchId != null) scheduleSatelliteCheck();
  }

  function exitStoppedMode(nowMs){
    var durMin = Math.max(1, Math.round((nowMs - stoppedSince) / 60000));
    logEvent('arranque', 'tras ' + durMin + ' min parado cerca de ' + stName(stoppedAtIdx));
    // Bloque 4A: limpiar todo el cableado de antenas/verif satelital ANTES de
    // marcar isStopped=false (los callbacks pendientes hacen `if(!isStopped) return`
    // como salvaguarda, pero es más limpio que ni siquiera se disparen).
    if(watchId != null){ GeoSource.watchStop(watchId); watchId = null; }
    if(satCheckTimer){ clearTimeout(satCheckTimer); satCheckTimer = null; }
    antennaDriftCount = 0;
    isStopped    = false;
    stoppedSince = 0;
    stoppedAtIdx = -1;
    slowReadings = [];
    coarseStill  = [];
    // Reanudar el ciclo normal de sondeo. El próximo pollTick reevalúa todo.
    if(tracking) schedulePoll();
  }

  // Callback del watchPosition durante PARADO (Bloque 4A). Solo escucha cambios
  // de posición sin coste — el chip GPS está apagado.
  function onAntennaReading(pos){
    if(!isStopped) return;   // salvaguarda
    if(pos.accuracy != null && pos.accuracy > ANTENNA_ACCURACY_IGNORE_M){
      antennaDriftCount = 0;
      return;
    }
    var d = haversineMeters(pos.lat, pos.lng, stoppedAtLat, stoppedAtLng);
    if(d > STOP_EXIT_DIST_M){
      antennaDriftCount++;
      if(antennaDriftCount >= ANTENNA_DRIFT_CONSEC){
        exitStoppedMode(Date.now());
      }
    } else {
      antennaDriftCount = 0;
    }
  }

  function scheduleSatelliteCheck(){
    if(satCheckTimer){ clearTimeout(satCheckTimer); satCheckTimer = null; }
    if(!isStopped) return;
    satCheckTimer = setTimeout(function(){
      satCheckTimer = null;
      runSatelliteCheck();
    }, SAT_VERIFY_INTERVAL_MS);
  }

  // ===== Arranque inteligente (Bloque 4B) ====================================
  // Al pulsar "Iniciar seguimiento": el chip GPS tarda 3-5 min en dar su primera
  // lectura satelital ("cold start"). Si la ventana de la 1ª estación markable
  // aún tarda en abrir, encender el chip ya es desperdicio puro de batería.
  // Decisión: si el tiempo hasta apertura ≥ 5 min, posponer el chip y usar
  // antenas para ir mostrando posición aproximada; programar el cold start
  // 5 min antes de la apertura para que esté caliente cuando la ventana abra.

  function decideColdStartDeferred(){
    if(gpsNextIdx < 0) return false;
    var eff = effTime(gpsNextIdx);
    var nowM = normNow(eff);
    var minutesToWindow = (eff - LEAD_MIN) - nowM;
    return minutesToWindow >= COLD_START_DEFER_MIN;
  }

  function enterColdStartDeferred(){
    preWindowDeferred = true;
    if(watchId == null) watchId = GeoSource.watchStart(onPreWindowAntenna);
    var eff = effTime(gpsNextIdx);
    var nowM = normNow(eff);
    var minutesToWindow = (eff - LEAD_MIN) - nowM;
    var msUntilProbe = Math.max(0, (minutesToWindow - COLD_START_PROBE_LEAD_MIN) * 60 * 1000);
    coldStartTimer = setTimeout(exitColdStartDeferred, msUntilProbe);
    logEvent('cold_defer', 'GPS pospuesto, antenas activas hasta ' + stName(gpsNextIdx) +
             ' (cold start en ' + Math.max(0, Math.round(minutesToWindow - COLD_START_PROBE_LEAD_MIN)) + ' min)');
    setStatus('Localización aproximada (antenas) — GPS satelital programado', 'ok');
  }

  function exitColdStartDeferred(){
    // BUG-FIX: guarda de re-entrada. El visibilitychange puede llamar aquí justo
    // antes (o después) de que dispare el coldStartTimer. Sin esto, una segunda
    // ejecución lanzaría un 2.º pollTick()+schedulePoll() en paralelo → dos
    // cadenas de sondeo simultáneas (doble batería, posibles dobles marcas).
    if(!preWindowDeferred) return;
    preWindowDeferred = false;
    if(coldStartTimer){ clearTimeout(coldStartTimer); coldStartTimer = null; }
    if(watchId != null){ GeoSource.watchStop(watchId); watchId = null; }
    if(!tracking) return;
    logEvent('cold_start', 'Activando chip GPS satelital');
    // Sonda de permiso satelital (igual que la rama inmediata).
    GeoSource.getCurrent().then(function(pos){
      var acc = pos.accuracy != null ? ' (precisión ' + Math.round(pos.accuracy) + 'm)' : '';
      setStatus('GPS activo — seguimiento iniciado' + acc, 'ok');
    }).catch(function(err){
      setStatus(gpsErrorMsg(err), 'warn');
    });
    pollTick();
    schedulePoll();
  }

  // Callback del watchPosition durante la espera previa a la 1ª ventana.
  // Solo actualiza el status — no se marca nada (ni siquiera se calcula CPA).
  function onPreWindowAntenna(pos){
    if(!preWindowDeferred) return;
    if(pos.accuracy != null && pos.accuracy < 5000){
      setStatus('Localización aproximada (señal celular) — esperando ' + stName(gpsNextIdx), 'ok');
    }
  }

  // Verificación periódica con chip GPS satelital durante PARADO. Cada 3 min
  // confirma que seguimos en el mismo sitio; si la lectura muestra movimiento
  // real (>1 km o velocidad clara), saca de PARADO aunque las antenas no lo
  // hayan notado.
  function runSatelliteCheck(){
    // D2: cerrojo. El visibilitychange puede dispararse 2× seguidas en algunos
    // móviles; sin esto tendríamos varios getCurrentPosition en vuelo, cada uno
    // reprogramando el timer al resolver (fuga de timers).
    if(!isStopped) return;
    if(satCheckInFlight){
      // Watchdog: si la promesa lleva demasiado en vuelo (no resolvió ni rechazó,
      // pasa en algunos Android tras background), liberar el cerrojo para que la
      // verificación periódica no muera para siempre.
      if(Date.now() - satCheckInFlightSince <= POLL_INFLIGHT_MAX_MS) return;
      satCheckInFlight = false;
    }
    satCheckInFlight = true;
    satCheckInFlightSince = Date.now();
    GeoSource.getCurrent().then(function(pos){
      satCheckInFlight = false;
      if(!isStopped) return;
      if(isFineFix(pos)){
        var d = haversineMeters(pos.lat, pos.lng, stoppedAtLat, stoppedAtLng);
        var moved = (d > SAT_VERIFY_EXIT_DIST_M) ||
                    (pos.speed != null && pos.speed > STOP_SPEED_MAX_MS);
        if(moved){ exitStoppedMode(Date.now()); return; }
      }
      scheduleSatelliteCheck();
    }).catch(function(){
      satCheckInFlight = false;
      if(isStopped) scheduleSatelliteCheck();
    });
  }

  // Llamada en cada pollTick con lectura fine válida. Decide si promover o salir.
  function updateStoppedState(pos, nowMs){
    if(!isFineFix(pos)) return;   // sin speed fiable no se puede evaluar
    coarseStill = [];             // hay GPS satelital: el criterio fine manda, el respaldo coarse se anula
    if(isStopped){
      // ¿Hay arranque? velocidad clara o desplazamiento real.
      var dFromStop = haversineMeters(pos.lat, pos.lng, stoppedAtLat, stoppedAtLng);
      var moving    = (pos.speed != null && pos.speed > STOP_SPEED_MAX_MS) ||
                      (dFromStop > STOP_EXIT_DIST_M);
      if(moving) exitStoppedMode(nowMs);
      return;
    }
    // No estamos parados: ¿esta lectura es lenta? Promueve o limpia.
    var slow = (pos.speed != null && pos.speed <= STOP_SPEED_MAX_MS);
    if(!slow){ slowReadings = []; return; }
    slowReadings.push({ ts: nowMs, lat: pos.lat, lng: pos.lng, speedMs: pos.speed });
    // BUG-FIX: el cap era STOP_CONFIRM_MIN_READINGS (3). Con cadencia de 30 s,
    // 3 lecturas abarcan 60 s y la condición de 90 s no se cumplía NUNCA: el
    // shift descartaba la lectura antigua justo antes de alcanzar el umbral.
    // El Bloque 4 entero era código muerto. Cap amplio: la ventana temporal
    // la decide la condición, no el tamaño del buffer.
    if(slowReadings.length > STOP_BUFFER_MAX) slowReadings.shift();
    if(slowReadings.length >= STOP_CONFIRM_MIN_READINGS &&
       (nowMs - slowReadings[0].ts) >= STOP_CONFIRM_MIN_MS){
      enterStoppedMode(pos.lat, pos.lng, nowMs);
    }
  }

  // Respaldo del plan (Bloque 4): confirmación de PARADO con lecturas coarse
  // (triangulación celular, sin speed) cuando no hay GPS satelital. Criterio:
  // STOP_CONFIRM_MIN_READINGS lecturas consecutivas a < STOP_COARSE_DIST_M unas
  // de otras durante al menos STOP_CONFIRM_MIN_MS. Antes este criterio del plan
  // no estaba implementado: en zona sin satélite — justo donde el estado PARADO
  // más importa — el detector quedaba ciego y estimateMark podía marcar en falso.
  function updateStoppedStateCoarse(pos, nowMs){
    if(isStopped) return;   // la salida durante PARADO la gestionan antenas + verif satelital
    if(pos.accuracy == null || pos.accuracy > STOP_COARSE_MAX_ACC_M) return;
    var last = coarseStill[coarseStill.length - 1];
    if(last && haversineMeters(pos.lat, pos.lng, last.lat, last.lng) > STOP_COARSE_DIST_M){
      coarseStill = [];     // se movió respecto a la anterior → la racha de quietud se rompe
    }
    coarseStill.push({ ts: nowMs, lat: pos.lat, lng: pos.lng });
    if(coarseStill.length > STOP_BUFFER_MAX) coarseStill.shift();
    if(coarseStill.length >= STOP_CONFIRM_MIN_READINGS &&
       (nowMs - coarseStill[0].ts) >= STOP_CONFIRM_MIN_MS){
      enterStoppedMode(pos.lat, pos.lng, nowMs);
    }
  }

  // ===== Registro de marcas ==================================================
  // Si el GPS reporta que ya pasamos por la parada actual, marcar con hora real.
  // - `skipped`: true cuando se marca en cadena (varias estaciones de golpe).
  // - `atMs`: timestamp del instante real del paso (CPA). Si null → hora actual.
  function autoMark(idx, skipped, atMs){
    if(API.getMark(idx) != null && API.getMarkSource(idx) === 'manual'){
      logEvent('conflicto', stName(idx) + ' — marca manual ' + API.getMark(idx) + ' conservada');
      setStatus('Conflicto en ' + stName(idx) + ': marca manual ' + API.getMark(idx) + ' conservada', 'warn');
      windowOpen = false;
      return;
    }
    var hhmm;
    if(atMs != null){
      hhmm = fmtHMfromMs(atMs);
    } else {
      var now = API.nowMin();
      hhmm = pad(Math.floor(now/60) % 24) + ':' + pad(Math.floor(now % 60));
    }
    API.setMark(idx, hhmm, 'gps');
    logEvent('paso', stName(idx) + ' ' + hhmm + (skipped ? ' · GPS (saltada en cadena)' : ' · GPS'));
    if(!skipped) setStatus('✓ ' + stName(idx) + ' ' + hhmm + ' (GPS)', 'ok');
    windowOpen = false;
    cpaResetHistory(-1);   // el historial pertenecía a la estación recién marcada
    lastFineReading = null; // su distM apuntaba a la estación marcada; reusarlo haría
                            // que schedulePoll sondease a 2 s hacia una estación lejana
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
    lastFineReading = null;  // mismo motivo que en autoMark: distM obsoleto
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
    // D1: guard completo. Bajo sondeo agresivo (2 s) con getCurrentPosition de
    // hasta 10 s, varios pollTick pueden estar en vuelo. Si uno entró en PARADO
    // o cold-start diferido mientras tanto, el siguiente NO debe sondear el chip
    // (lectura zombi que ensucia el estado con datos viejos).
    if(!tracking || isStopped || preWindowDeferred) return;
    // BUG-FIX (concurrencia): un solo getCurrentPosition en vuelo a la vez. Con
    // sondeo de 2 s y GPS tardando 3-5 s, dos pollTick se solapaban: el 2.º
    // resolvía "del pasado" tras un autoMark que ya había avanzado gpsNextIdx,
    // y mezclaba la distancia hacia la estación vieja en el historial CPA de la
    // nueva (marca falsa o timestamp erróneo). El cerrojo lo impide; el reloj
    // sigue programando ticks y el siguiente sondea cuando este libere.
    if(pollInFlight){
      // Watchdog: si la promesa en vuelo lleva > POLL_INFLIGHT_MAX_MS sin resolver
      // ni rechazar (pasa en algunos Android al volver de background, pese al
      // timeout:10000), liberar el cerrojo: sin esto el tracking moriría en
      // silencio para siempre. Si la promesa zombi resuelve más tarde, su token
      // de secuencia ya no coincidirá y se descartará.
      if(Date.now() - pollInFlightSince <= POLL_INFLIGHT_MAX_MS) return;
      pollInFlight = false;
    }
    recomputeNext();
    if(gpsNextIdx < 0){ setStatus('Marcha completada', 'ok'); return; }

    var name = stName(gpsNextIdx);
    var eff  = effTime(gpsNextIdx);
    var nowM = normNow(eff);

    if(!windowOpen){
      if(nowM >= eff - LEAD_MIN){ windowOpen = true; gpsFailCount = 0; ltvWait = false; }
      else { setStatus('Próxima estación: ' + name + ' · hora prevista ' + fmtHM(eff)); return; }
    }

    // Ventana abierta → consultar el GPS
    // BUG-FIX (carrera con marca manual): la lectura tarda hasta 10 s. Si durante
    // el vuelo el maquinista marca a mano, logManualMark avanza gpsNextIdx y este
    // closure quedaría con `name`/`eff` de la estación ANTIGUA: la distancia hacia
    // ella se inyectaría como primera entrada del historial CPA de la NUEVA (si el
    // tren pasaba a < 100 m de la vieja, cpa-near marcaría la nueva en falso).
    // Se captura el idx objetivo y se descarta la resolución si cambió.
    var targetIdx = gpsNextIdx;
    var mySeq = ++pollSeq;
    pollInFlight = true;
    pollInFlightSince = Date.now();
    GeoSource.getCurrent().then(function(pos){
      if(mySeq !== pollSeq) return;       // resolución zombi superada por el watchdog
      pollInFlight = false;
      if(!tracking) return;
      if(gpsNextIdx !== targetIdx) return; // el objetivo cambió durante el vuelo (marca manual)
      // Bloque 3: filtros de calidad. Tres motivos para rechazar una lectura
      // como "no marcable" (cuentan como fallo de GPS, aceleran sondeo y, si
      // persisten hasta el GIVEUP, terminan en estimateMark con 'est'):
      //   1. accuracy > 1500 m → basura para cualquier uso.
      //   2. coarse fix (sin speed) → es triangulación celular, no satélite.
      //   3. accuracy excede el umbral para la velocidad actual del tren.
      var poorReading = false;
      var poorReason = '';
      if(pos.accuracy != null && pos.accuracy > TRACKING_ACCURACY_M){
        poorReading = true;
        poorReason = 'GPS impreciso (' + Math.round(pos.accuracy) + 'm)';
      } else if(!isFineFix(pos)){
        poorReading = true;
        poorReason = 'GPS aproximado (señal celular) — esperando satélite';
      } else {
        var speedKmh = (pos.speed || 0) * 3.6;
        var maxAcc = accuracyThresholdForSpeed(speedKmh);
        if(pos.accuracy != null && pos.accuracy > maxAcc){
          poorReading = true;
          poorReason = 'GPS impreciso (' + Math.round(pos.accuracy) + 'm > ' +
                       maxAcc + 'm a ' + Math.round(speedKmh) + ' km/h)';
        }
      }
      if(poorReading){
        gpsFailCount++;
        // Bloque 4 (respaldo del plan): una lectura coarse con accuracy razonable
        // sirve para evaluar quietud por proximidad entre lecturas consecutivas,
        // aunque no sirva para marcar. Sin esto, en zona sin satélite el detector
        // de parado quedaba ciego — justo donde más falta hace.
        if(!isFineFix(pos)) updateStoppedStateCoarse(pos, Date.now());
        if(isStopped){
          setStatus('Tren detenido (confirmado por antenas) — esperando arranque cerca de ' + name, 'warn');
          return;
        }
        var effImp = effTime(gpsNextIdx);
        // Bloque 1+4: si ltvWait o isStopped están activos, NO marcar como
        // estimada aunque venza el giveup — el tren está confirmado lejos o
        // físicamente sin moverse, y un 'est' aquí sería falso.
        if(!ltvWait && !isStopped && normNow(effImp) >= effImp + Math.min(GIVEUP_MIN + gpsFailCount, GIVEUP_MAX)){
          estimateMark(gpsNextIdx);
          return;
        }
        setStatus(poorReason + ' — esperando mejor señal', 'warn');
        return;
      }
      gpsFailCount = 0;   // lectura usable: reinicia el contador de fallos
      var pr = projectGps(pos.lat, pos.lng);
      if(!pr){ logEvent('fuera_ruta', 'GPS fuera de la ruta', 'fuera'); setStatus('GPS fuera de la ruta — ¿tren correcto?', 'warn'); return; }

      // Bloque 2: actualizar historial CPA hacia la estación destino actual.
      // El historial se mantiene SOLO para fine fix legítimo (ya hemos filtrado
      // los coarse y los imprecisos arriba) y SOLO mientras gpsNextIdx no cambie.
      var nowMs = Date.now();
      var targetCoord = API.COORDS[name];
      var distM = targetCoord ? haversineMeters(pos.lat, pos.lng, targetCoord[0], targetCoord[1]) : null;
      // Bloque 1: guardar última lectura fine para que schedulePoll la use.
      lastFineReading = { ts: nowMs, distM: distM, speedMs: pos.speed };

      // Bloque 4: actualizar detector de parado y, si estamos PARADO, abortar
      // el resto del flujo (no CPA, no marca, no LTV — el tren no se mueve).
      updateStoppedState(pos, nowMs);
      if(isStopped){
        var durMin = Math.floor((nowMs - stoppedSince) / 60000);
        var sufijo = (durMin >= 1) ? (' (' + durMin + ' min)') : '';
        setStatus('Tren detenido — esperando arranque cerca de ' + name + sufijo, 'warn');
        return;
      }

      // Bloque 1: mitigación parcial DHLTV. Si el tren está confirmado a >5 km
      // de la estación destino mientras la ventana ya está abierta (hora teórica
      // próxima), una LTV activa lo retrasa. Bloquear giveup y CPA hasta que se
      // acerque, evitando un 'est' falso con la hora teórica.
      if(distM != null && distM > LTV_FAR_THRESHOLD_M){
        if(!ltvWait){
          ltvWait = true;
          logEvent('ltv_wait', name + ' a ' + Math.round(distM/1000) + ' km — esperando aproximación (LTV)');
        }
        setStatus('Tren a ' + Math.round(distM/1000) + ' km de ' + name + ' — esperando aproximación (posible LTV)', 'warn');
        return;
      } else if(ltvWait){
        ltvWait = false;
        logEvent('ltv_clear', name + ' a ' + Math.round(distM) + ' m — aproximación reanudada');
      }

      if(distM != null) cpaUpdateHistory(distM, pos, nowMs);
      var cpa = (distM != null) ? cpaDetectPass() : { passed: false };

      if(pr.passedOrigIdx != null && pr.passedOrigIdx > gpsNextIdx){
        // Salto múltiple (varias estaciones de golpe, tras túnel largo o background):
        // chain marking con hora actual — sin historial CPA aprovechable para esas.
        var safety = 0;
        while(gpsNextIdx >= 0 && pr.passedOrigIdx >= gpsNextIdx && safety < 50){
          var wasSkipped = pr.passedOrigIdx > gpsNextIdx;
          autoMark(gpsNextIdx, wasSkipped);
          safety++;
        }
      } else if(cpa.passed){
        // CPA: paso confirmado por el mínimo de distancia. Timestamp interpolado
        // del momento físico real → precisión 50–200 m vs 1–2 km del criterio
        // geométrico de hoy.
        logEvent('cpa', name + ' · ' + cpa.via + ' · dist actual ' + Math.round(distM) + 'm');
        autoMark(gpsNextIdx, false, cpa.atMs);
      } else if(pr.passedOrigIdx === gpsNextIdx){
        // La geometría (snap.t > 0.6, el criterio antiguo) dice que pasó. Pero si
        // el historial CPA muestra la distancia AÚN BAJANDO, físicamente no hemos
        // llegado al punto más cercano: marcar ahora reintroduciría el error de
        // 1–2 km que este plan elimina (ocurre cuando la coordenada de la estación
        // no cae sobre el último vértice de la polyline). Se difiere al CPA, que
        // confirmará el mínimo en las próximas lecturas; si las lecturas mueren
        // (túnel), lo cubren la mitigación de hueco o el giveup.
        var nH = cpaHistory.length;
        var stillApproaching = nH >= 2 &&
          cpaHistory[nH-1].distM < cpaHistory[nH-2].distM;
        if(stillApproaching){
          logEvent('geo_defer', name + ' — geometría indica paso pero la distancia aún baja (' +
                   Math.round(distM) + ' m); esperando mínimo CPA', 'geodefer' + gpsNextIdx);
          setStatus('Llegando a ' + name + ' · ' + Math.round(distM) + ' m', 'ok');
        } else {
          // Sin historial aprovechable (cold start dentro de la estación, primera
          // lectura ya past): marcar con hora actual — es la mejor disponible.
          autoMark(gpsNextIdx, false);
        }
      } else {
        // `eff`/`nowM` se calcularon ANTES de la llamada GPS (hasta 10 s antes);
        // recalcular aquí para que el retraso provisional no arrastre ese desfase.
        var effNow  = effTime(gpsNextIdx);
        var nowMNow = normNow(effNow);
        if(nowMNow > effNow + 0.5){
          var prov = currentDelta() + (nowMNow - effNow);
          API.setProvisionalDelay(prov);
          logEvent('retraso', '+' + Math.round(prov) + ' min provisional hacia ' + name, 'retraso' + Math.round(prov));
          setStatus('Retraso creciendo: +' + fmtDur(prov) + ' · sin pasar aún ' + name, 'warn');
        } else {
          API.setProvisionalDelay(null);
          var distInfo = distM != null ? ' · ' + Math.round(distM) + 'm' : '';
          setStatus('En ruta hacia ' + name + ' (previsto ' + fmtHM(effNow) + ')' + distInfo);
        }
      }
    }).catch(function(err){
      if(mySeq !== pollSeq) return;        // rechazo zombi superado por el watchdog
      pollInFlight = false;
      if(!tracking) return;
      if(gpsNextIdx !== targetIdx) return; // el objetivo cambió durante el vuelo (marca manual)
      gpsFailCount++;
      // Margen de gracia (N2): el 1.er fallo mantiene la posición (el tren puede
      // seguir parado, o ser un parpadeo aislado del GPS). A partir del 2.º fallo
      // SEGUIDO, sin confirmación de "parado", se pasa al Caso 2: se limpia el
      // retraso provisional para que updatePosition deje avanzar el icono por tiempo.
      // Exigir dos fallos consecutivos evita oscilar ante un parpadeo suelto de señal.
      // Bloque 4: si estamos parado confirmado, NO limpiar provisionalDelay
      // (el icono debe quedarse fijo en la última estación marcada, no avanzar
      // por tiempo cuando físicamente seguimos donde estábamos).
      if(gpsFailCount >= 2 && !isStopped && API.setProvisionalDelay) API.setProvisionalDelay(null);
      var eff2 = effTime(gpsNextIdx);
      // GIVEUP adaptativo: cada fallo añade 1 min al margen, hasta GIVEUP_MAX.
      // 0 fallos → 3 min | 1 fallo → 4 min | 2+ fallos → 5 min (cap).
      var giveUpMin = Math.min(GIVEUP_MIN + gpsFailCount, GIVEUP_MAX);
      // Bloque 1+4: suprimido durante ltvWait o isStopped — no marcar 'est'
      // si el tren está confirmado lejos o sin moverse.
      var giveUp = !ltvWait && !isStopped && (normNow(eff2) >= eff2 + giveUpMin);
      if(giveUp){
        estimateMark(gpsNextIdx);
      } else {
        var msg = gpsErrorMsg(err);
        logEvent('sin_senal', msg + ' cerca de ' + name, 'sinsenal' + (err && err.code));
        setStatus(msg + ' · cerca de ' + name, 'warn');
      }
    });
  }

  // Reconciliación tras 2.º plano: en móvil los timers se congelan cuando la app
  // pasa a segundo plano o se bloquea la pantalla, así que las ventanas de varias
  // estaciones pueden vencer sin sondearse. Al volver el foco, esta función rellena
  // EN UNA SOLA PASADA, por estimación, todas las estaciones cuya ventana ya venció
  // del todo (now > hora efectiva + GIVEUP_MAX) mientras la app estuvo suspendida.
  // Se detiene en la primera estación cuyo margen aún NO ha vencido: esa se deja a
  // la consulta de GPS en vivo (pollTick), que tiene prioridad sobre la estimación.
  function catchUp(){
    if(!tracking) return;
    recomputeNext();
    var guard = 0;
    while(gpsNextIdx >= 0 && guard < 100){
      var eff = effTime(gpsNextIdx);
      // Bloque 1+4: si ltvWait o isStopped persisten tras background, NO
      // marcar 'est' en chain — el tren está físicamente lejos o parado, y la
      // estimación sería falsa. El próximo pollTick reevaluará con dato real.
      if(!ltvWait && !isStopped && normNow(eff) >= eff + GIVEUP_MAX){
        estimateMark(gpsNextIdx);   // marca 'est' y llama a recomputeNext()
        guard++;
      } else {
        break;                       // estación "actual": la resuelve el GPS en vivo
      }
    }
  }

  // ===== Arranque / parada ===================================================
  // Planificación adaptativa (Bloque 1): el intervalo de sondeo se ajusta a la
  // situación. Una sola fórmula, sin "modos":
  //   - Ventana cerrada           → 30 s (igual que antes)
  //   - Ventana abierta + fallos  → 15 s ("fail mode" — pillar antes una buena)
  //   - Ventana abierta + última  → (distancia ÷ velocidad) − 15 s, clamp [2, 30]
  //     fine válida y v > 0,5 m/s   La fórmula adelanta el sondeo proporcional al
  //                                  tiempo restante hasta la estación. A 4 km y
  //                                  75 m/s → 38 s (tope 30). A 600 m y 30 m/s
  //                                  → 5 s. A 50 m y 22 m/s → 2 s (tope mín).
  //                                  → 6 lecturas durante el cruce físico vs 0-1
  //                                    con sondeo fijo de 30 s. Precisión clave.
  //   - Sin datos para adaptar     → 30 s (fallback prudente)
  function schedulePoll(){
    // Idempotencia: limpiar cualquier timer pendiente antes de programar. Sin
    // esto, una llamada doble (p. ej. visibilitychange + cadena viva) crearía
    // DOS cadenas de sondeo paralelas: doble batería y dobles lecturas.
    if(pollTimer){ clearTimeout(pollTimer); pollTimer = null; }
    // Bloque 4A: durante PARADO el ciclo queda en pausa (antenas + verif
    // satelital cada 3 min se encargan). Bloque 4B: durante el diferido del
    // cold start tampoco — el setTimeout coldStartTimer es el único disparador.
    if(!tracking || isStopped || preWindowDeferred) return;
    var delay;
    if(!windowOpen){
      delay = POLL_MS;
    } else if(gpsFailCount > 0){
      delay = POLL_MS_FAST;
    } else if(lastFineReading && lastFineReading.distM != null &&
              lastFineReading.speedMs != null && lastFineReading.speedMs > POLL_SPEED_MIN_MS){
      var raw = (lastFineReading.distM / lastFineReading.speedMs) - POLL_LEAD_S;
      var clamped = Math.max(POLL_MIN_MS/1000, Math.min(POLL_MS/1000, raw));
      delay = Math.round(clamped * 1000);
    } else {
      delay = POLL_MS;
    }
    pollTimer = setTimeout(function(){
      pollTick();
      schedulePoll();
    }, delay);
  }

  function startTracking(){
    if(tracking) return;
    var m = API.getMarch();
    if(!m){ setStatus('No hay marcha seleccionada', 'warn'); return; }
    // R4: asegurar hora real (descarta el modo de hora manual si quedó activo).
    if(API.forceLiveTime) API.forceLiveTime();
    tracking = true; windowOpen = false; gpsFailCount = 0; armed = false;
    recomputeNext();
    // Activa el seguimiento por hora (resaltado de posición) al iniciar el GPS.
    // El maquinista puede luego alternarlo ON/OFF sin afectar al GPS.
    if(API.enableHourFollow) API.enableHourFollow();
    // Centinela de sesión: sobrevive a cambio de app, se borra al cerrar el
    // navegador. Si al cargar la app no existe pero hay marcas guardadas →
    // se detecta cierre real → index.html muestra el diálogo de recuperación.
    try{ sessionStorage.setItem('ebula_servicio_activo', (API.getTickKey && API.getTickKey()) || '1'); }catch(e){}
    logEvent('inicio', 'Seguimiento iniciado · ' + (m.t || '') + ' ' + (m.o || '') + '→' + (m.d || ''));
    requestWakeLock();
    if(pollTimer){ clearTimeout(pollTimer); pollTimer = null; }
    updateButton();

    // Bloque 4B: ¿hay margen para diferir el cold start del chip GPS?
    // - <5 min a la 1ª ventana → arranque inmediato (chip GPS + antenas).
    // - ≥5 min                 → solo antenas; cold start programado para 5 min
    //                            antes de la apertura (chip ya caliente al abrir).
    if(decideColdStartDeferred()){
      enterColdStartDeferred();
    } else {
      // Sonda de permiso dentro del gesto del usuario.
      GeoSource.getCurrent().then(function(pos){
        var acc = pos.accuracy != null ? ' (precisión ' + Math.round(pos.accuracy) + 'm)' : '';
        setStatus('GPS activo — seguimiento iniciado' + acc, 'ok');
      }).catch(function(err){
        setStatus(gpsErrorMsg(err), 'warn');
      });
      pollTick();
      schedulePoll();
    }
  }

  function stopTracking(){
    if(tracking) logEvent('fin', 'Seguimiento detenido');
    tracking = false; windowOpen = false;
    if(pollTimer){ clearTimeout(pollTimer); pollTimer = null; }
    cpaResetHistory(-1);
    lastFineReading = null;
    ltvWait = false;
    pollInFlight = false;
    isStopped = false;
    stoppedSince = 0;
    stoppedAtIdx = -1;
    slowReadings = [];
    coarseStill  = [];
    pollSeq++;               // invalida cualquier lectura en vuelo
    if(watchId != null){ GeoSource.watchStop(watchId); watchId = null; }
    if(satCheckTimer){ clearTimeout(satCheckTimer); satCheckTimer = null; }
    if(coldStartTimer){ clearTimeout(coldStartTimer); coldStartTimer = null; }
    satCheckInFlight = false;
    antennaDriftCount = 0;
    preWindowDeferred = false;
    // Parada explícita por el maquinista: libera el centinela de sesión.
    try{ sessionStorage.removeItem('ebula_servicio_activo'); }catch(e){}
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
        hideAction();
        requestWakeLock();
        if(isStopped){
          // Bloque 4A: en background, el watch puede haberse pausado y el
          // timer de verif satelital puede haberse pospuesto. Refrescar ambos
          // y forzar una verif inmediata para confirmar que seguimos parados.
          if(watchId != null){ GeoSource.watchStop(watchId); watchId = null; }
          watchId = GeoSource.watchStart(onAntennaReading);
          if(satCheckTimer){ clearTimeout(satCheckTimer); satCheckTimer = null; }
          runSatelliteCheck();
          setStatus('Tren detenido — esperando arranque (cerca de ' + stName(stoppedAtIdx) + ')', 'warn');
        } else if(preWindowDeferred){
          // Bloque 4B: el watch y el setTimeout pueden venir throttled.
          // Refrescar watch. Si el tiempo a la ventana ya bajó del umbral,
          // salir del diferido inmediatamente (el chip GPS necesita calentarse).
          if(watchId != null){ GeoSource.watchStop(watchId); watchId = null; }
          watchId = GeoSource.watchStart(onPreWindowAntenna);
          if(!decideColdStartDeferred()){
            exitColdStartDeferred();
          }
        } else {
          // Reconciliación AUTOMÁTICA: sin depender de que el maquinista toque
          // nada. Primero rellena las estaciones cuya ventana venció mientras
          // la app estuvo suspendida; luego consulta el GPS para la estación
          // actual y REPROGRAMA la cadena de sondeo: algunos sistemas matan el
          // setTimeout pendiente en background y, sin esto, el tracking quedaría
          // sin ticks futuros. schedulePoll es idempotente (limpia el timer
          // viejo si seguía vivo), así que no hay riesgo de cadena doble.
          catchUp();
          pollTick();
          schedulePoll();
          setStatus('Localización reactivada — posición recuperada', 'ok');
        }
      }
    }
  });

  API.onMarchaChange(function(){
    if(tracking) stopTracking();
    windowOpen = false; gpsNextIdx = -1; armed = false;
    cpaResetHistory(-1);
    lastFineReading = null;
    ltvWait = false;
    pollInFlight = false;
    isStopped = false;
    stoppedSince = 0;
    stoppedAtIdx = -1;
    slowReadings = [];
    coarseStill  = [];
    pollSeq++;               // invalida cualquier lectura en vuelo de la marcha anterior
    if(watchId != null){ GeoSource.watchStop(watchId); watchId = null; }
    if(satCheckTimer){ clearTimeout(satCheckTimer); satCheckTimer = null; }
    if(coldStartTimer){ clearTimeout(coldStartTimer); coldStartTimer = null; }
    satCheckInFlight = false;
    antennaDriftCount = 0;
    preWindowDeferred = false;
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
  // Tras la marca manual, el GPS deja la estación marcada y avanza a la siguiente:
  // cierra la ventana actual y recalcula gpsNextIdx. Entre la estación marcada
  // y la siguiente, la posición se calcula por tiempo (lógica de updatePosition).
  // Cuando el tren entre en la ventana de la nueva siguiente estación, el GPS
  // intentará localizarla con la lógica normal. Si el maquinista borra la marca
  // (clearPunch en index.html, por marcado erróneo), recomputeNext del siguiente
  // pollTick volverá a apuntar a esa misma estación de forma natural.
  API.logManualMark = function(idx){
    logEvent('paso', stName(idx) + ' · manual');
    windowOpen = false;
    gpsFailCount = 0;
    cpaResetHistory(-1);
    ltvWait = false;
    var wasStopped = isStopped;
    if(isStopped){
      // Marca manual durante PARADO: el maquinista confirma paso. Salir limpio.
      if(watchId != null){ GeoSource.watchStop(watchId); watchId = null; }
      if(satCheckTimer){ clearTimeout(satCheckTimer); satCheckTimer = null; }
      antennaDriftCount = 0;
    }
    isStopped = false;
    stoppedSince = 0;
    stoppedAtIdx = -1;
    slowReadings = [];
    coarseStill  = [];
    lastFineReading = null;   // su distM apuntaba a la estación recién marcada a mano
    recomputeNext();
    // BUG-FIX: si veníamos de PARADO, enterStoppedMode había cancelado pollTimer
    // y delegado en antenas/sat. Esos ya están cerrados arriba, así que sin esto
    // el seguimiento quedaría sin ningún temporizador activo (tracking ciego).
    // Reanudar el ciclo normal de sondeo.
    if(wasStopped && tracking) schedulePoll();
  };
  buildUI();
  checkDeparture();
  armTimer = setInterval(checkDeparture, 20000);
})();
