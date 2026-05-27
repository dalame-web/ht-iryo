# HT-Iryo — Historia técnica completa

> Export exhaustivo para integrar HT Iryo como módulo en **Iryo-Studio** (PWA unificada que fusionará HT + RV).
> Generado el 2026-05-27 sobre el repo `dalame-web/ht-iryo` en el commit `1ab6e38` (rama `main`).

> **Aviso importante — corrección al brief:** la petición mencionaba *"login Keycloak"* y *"virtual scroll del calendario"*. **Ninguno de los dos existe en HT-Iryo.** Pertenecen a otro proyecto distinto (el scraper IVU `shift_sync`, que sí usa Keycloak para autenticarse contra el portal de Trenitalia y maneja el `cdk-virtual-scroll-viewport` de Angular). HT-Iryo es una PWA estática sin ninguno de esos dos elementos; lo que sí tiene se documenta en su lugar (sección 5.1).

---

## 1. Resumen ejecutivo

**Qué es:** PWA interna no oficial para personal de conducción de Iryo (operadora española de alta velocidad). Una sola página servida estáticamente; sin backend.

**Para quién:** maquinistas de Iryo. Herramienta de consulta y registro durante el servicio:
- ver el horario teórico del tren (marcha),
- saber por dónde va,
- registrar el paso real por estación (manual o por GPS),
- consultar limitaciones de velocidad publicadas (DHLTV),
- en su día también tiempos reales (ADIF, hoy oculto).

**Estado legal:** herramienta no oficial. Distribución fuera del ámbito interno prohibida; el propio Uso web de la app lo deja explícito. La documentación oficial siempre prevalece.

**Autoría:**
- Autor original: David Muñoz Primo (`davidmprimo@gmail.com`), repo `github.com/deiividmz/deiividmz.github.io` (GitHub Pages).
- Versión que se integra: la copia/mejora de David Alameda (`david.alameda01@gmail.com`), repo `github.com/dalame-web/ht-iryo`, alojada en Netlify.
- Las dos divergieron a partir del commit upstream `54bb762`. Se mantiene un seguimiento manual del repo original (ver `UPSTREAM_SYNC.md`).

**Tecnología:** HTML + JavaScript vanilla en un único archivo (~921 KB). Sin framework. Sin build. Service Worker para offline básico. Librerías de terceros vía CDN (Leaflet, pdf.js).

---

## 2. Arquitectura — archivos del repo

```
ht-iryo/
├── index.html              (~921 KB, ~4.700 líneas) — la app entera
├── gps-tracking.js         (~15 KB) — módulo de seguimiento GPS
├── sw.js                    Service Worker (cache-first; ebula-v10)
├── manifest.webmanifest     PWA manifest (standalone, theme rojo Iryo)
├── icon-192.png             iconos PWA
├── icon-512.png
├── icon-192-maskable.png
├── icon-512-maskable.png
├── README.md                disclaimer legal (uso interno)
├── UPSTREAM_SYNC.md         seguimiento del repo original (marcador + historial de portes)
├── HT_HISTORIA.md           este archivo
└── .gitignore
```

### 2.1 `index.html` — la app entera
Concentra TODO menos el GPS. De arriba abajo:
- `<head>`: meta PWA + carga CDN: Leaflet 1.9.4 (CSS + JS), Google Fonts Poppins, pdf.js 3.11.174 (+ worker). Antes también cargaba `@microsoft/signalr` 8.0.7 y `jsPDF` 2.5.1 + jspdf-autotable; **eliminados por upstream en `ba67b48`**.
- `<style>`: CSS de toda la app — variables, temas claro/oscuro, layout, header, tabla, mapa, ADIF, DHLTV, overlay PIN, prompt PWA.
- HTML de las pantallas: overlay de login PIN, prompt de instalación PWA, navegación de pestañas, paneles de cada pestaña.
- Tres bloques `<script type="application/json">` con datos embebidos: `data` (horarios), `coords` (coordenadas), `lines` (geometrías LAV), `station-lines` (clasificación estación → línea).
- IIFE principal (~3.000 líneas de JS) con toda la lógica: login, instalación PWA, ADIF, mapa Leaflet, horario, DHLTV, navegación, temas, API `window.HTIryo`.
- Al final, `<script src="gps-tracking.js" defer>`.

### 2.2 `gps-tracking.js` — módulo separado
Aislado para que `index.html` se toque lo mínimo cuando se actualiza el GPS. Sólo depende de `window.HTIryo` (la API que index.html le expone). Está pensado para sustituir su capa `GeoSource` por `@capacitor/geolocation` si en el futuro se empaqueta como app nativa.

### 2.3 `sw.js` — Service Worker
Cache-first muy simple. Precachea los locales (HTML + JS + manifest + iconos). Solo cachea respuestas `status===200 && type==='basic'` (mismo origen). Versión actual `ebula-v10`. Se sube el número cada vez que cambia el contenido para forzar invalidación en la tablet.

### 2.4 `manifest.webmanifest`
`display: standalone`, `theme_color: #e8201c` (rojo Iryo), `background_color: #0d1117`, `start_url: ./index.html`, iconos `any` + `maskable` 192/512, `lang: "es"`, `orientation: "any"`.

### 2.5 `UPSTREAM_SYNC.md`
Marcador del último commit upstream revisado + tabla-historial de portes. Lo gestiona un **chat dedicado** en Claude Code (no este). Procedimiento: `git fetch upstream` → `git log <marcador>..upstream/main` → `git diff` → revisión + porte manual sin tocar GPS.

---

## 3. Pestañas — visibles y ocultas

Definidas en `<div class="tabs">` (≈ línea 1370). El `<body>` lleva una clase `tab-<nombre>` que controla qué pestaña está activa y la visibilidad del header del Horario (sólo visible en `tab-schedule`).

### 3.1 Visibles (orden actual)

| Pestaña | `data-tab` | Pane | Qué muestra |
|---|---|---|---|
| 🏠 Inicio | `home` | `#home-pane` | Pantalla de entrada con accesos directos a Horario / DHLTV. |
| ▦ Horario | `schedule` | `#schedule-pane` | Pestaña principal: marcha del tren seleccionado, marcaje real por estación, retraso/adelanto, posición actual, GPS. |
| ⚠ DHLTV | `dhltv` | `#dhltv-pane` | Limitaciones Temporales de Velocidad. Sube un PDF DHLTV oficial; lo parsea con pdf.js y muestra las LTV agrupadas por línea. Inyecta filas LTV bajo las paradas afectadas del Horario. |
| ⚖ Uso web | `usoweb` | `#usoweb-pane` | Aviso legal: la app no sustituye documentación oficial; prohibida la difusión externa. |

### 3.2 Ocultas (siguen en el HTML, `style="display:none"`)

| Pestaña | Estado | Por qué | Qué hacía |
|---|---|---|---|
| 📡 ADIF | Oculta desde el porte de `ba67b48` (upstream). El botón en Inicio también. | El autor original eliminó la librería SignalR. HTML + JS siguen presentes pero sin librería no funciona. | Conexión SignalR a `https://info.adif.es/InfoStation` por estación, hub `ECM-<código>`. Filtra solo trenes Iryo. Auto-refresco 60 s. Cache `ebula_adif_v2`. Inyectaba badges VÍA / retraso en las filas del horario. |
| 🗺 Mapa | Oculta también desde `ba67b48`. | Pierde sentido sin ADIF en vivo. Leaflet sigue cargado. | Mapa Leaflet con OSM. Líneas LAV de fondo, marcadores de estaciones, ruta del tren y posición interpolada con `trainPositionAt()`. |

> **Nota para Iryo-Studio:** la decisión upstream de ocultar ADIF/Mapa es discutible. Si Iryo-Studio quiere conservarlos, el código está intacto bajo el `display:none`; basta restaurar el `<script>` de SignalR y reactivar los botones. **`buildMarchaPath` / `snapToPolyline` / `getPath` se siguen usando** porque el GPS los necesita aunque la pestaña Mapa esté oculta.

---

## 4. Modelo de datos

### 4.1 `<script id="data">` — Horarios

Estructura: objeto agrupado `{ "<grp>": [ Marcha, ... ], ... }` donde `<grp>` es el identificador del PDF/grupo (p. ej. `"306"`).

**Marcha** (un tren-trayecto):
```jsonc
{
  "t":  "6010",                       // Número de tren (string)
  "tp": "300A",                       // Tipo de material rodante
  "o":  "BARCELONA-SANTS",            // Origen
  "d":  "SEVILLA-SANTA JUSTA",        // Destino
  "s":  [ Estacion, ... ]             // Secuencia de estaciones/dependencias
}
```

**Estacion** (`s[i]`):
```jsonc
{
  "k":  621.0,            // PK (km) — number, una cifra decimal
  "n":  "BARCELONA-SANTS",// Nombre (puede ser null en marcadores km)
  "h":  "09:20",          // Hora teórica HH:MM (string) — sólo en paradas con tiempo
  "tm": 560,              // Hora teórica en minutos desde 00:00 — fuente para cálculos
  "v":  300,              // VMáx desde aquí (km/h) — render con rowspan
  "vh": true,             // Celda VMáx resaltada (cuadro sombreado del PDF original)
  "b":  "BCA",            // Bloqueo del tramo (columna quitada por upstream ba67b48)
  "c":  5,                // Minutos de parada comercial (presente => parada)
  "tc": 2,                // Minutos de parada técnica
  "_l010cdi": true        // Dependencia BCE/CDI de la línea 010 (filas violetas, no son paradas)
}
```

Reglas:
- `isComStop = !isCdi && (!!s.c || idx===0 || idx===lastIdx)` — parada comercial = tiene `c`, o es origen, o es destino.
- `_l010cdi` excluye la fila del marcaje y del GPS (`isMarkable`).
- `v` y `b` se renderizan con celdas combinadas mediante `computeSpans()` agrupando filas consecutivas con el mismo valor (admite huecos vacíos entre medias si `mergeAcrossEmpty=true`).

### 4.2 `<script id="coords">` — Coordenadas

`{ "<nombre_estacion>": [lat, lng], ... }`. Diccionario plano, ≈207 estaciones con nombre que coinciden con las de `data`. Lat/lng en grados decimales. Lo usan:
- el GPS (proyección sobre la ruta),
- el Mapa (marcadores y ruta),
- `linesForStop` como fallback de proximidad cuando una estación no está en `station-lines`.

### 4.3 `<script id="lines">` — Geometrías LAV

`{ "<codigo_linea>": [[lat,lng], ...], ... }`. Polilíneas de las líneas de alta velocidad españolas que recorre Iryo. Códigos vistos: `010`, `030`, `040`, `042`, `050`, `054`. Lo usa `buildMarchaPath()`: para cada pareja de paradas consecutivas, proyecta ambas sobre cada línea LAV y se queda con la que minimiza la suma de distancias.

### 4.4 `<script id="station-lines">` — Estación → líneas

`{ "<nombre_estacion>": ["010", "050", ...], ... }`. Para cada estación, los códigos de línea en los que aparece (clasificación por contexto del horario, no por proximidad). Se usa para emparejar LTV con paradas: una LTV solo se considera si su línea está entre las "predominantes" del tren, evitando falsos positivos en cabeceras compartidas (p. ej. salida sur de Atocha, donde L010 y L050 viajan juntas).

### 4.5 Marcas / punteo

**`localStorage['ebula_punches_v2']`:**
```jsonc
{
  "306|6010|BARCELONA-SANTS→SEVILLA-SANTA JUSTA": {
    "1": "09:25",
    "5": "09:31"
  }
}
```
- Clave externa: `tickKey() = curGrp + "|" + march.t + "|" + march.o + "→" + march.d`.
- Clave interna: índice en `march.s` (string).
- Valor: hora HH:MM.

**`localStorage['ebula_marksrc_v1']`** (mismo schema):
```jsonc
{
  "306|6010|...": {
    "1": "manual",   // 'manual' | 'gps' | 'est'
    "5": "gps"
  }
}
```
La fuente determina si la marca se muestra con `~` (estimada) o sin prefijo (real). El GPS **no sobreescribe** marcas `manual` (regla de conflicto en `autoMark`).

### 4.6 Log GPS

**`localStorage['ebula_gpslog_v1']`:**
```jsonc
{
  "306|6010|...": [
    {"t":"09:25:11","tipo":"inicio","detalle":"Seguimiento iniciado · 6010 BARCELONA-SANTS→SEVILLA-SANTA JUSTA"},
    {"t":"09:31:42","tipo":"paso","detalle":"CAMP DE TARRAGONA 09:31 · GPS"},
    {"t":"10:02:05","tipo":"sin_senal","detalle":"Sin señal cerca de ZARAGOZA-DELICIAS"},
    {"t":"10:04:33","tipo":"retraso","detalle":"+3 min provisional hacia ZARAGOZA-DELICIAS"},
    {"t":"10:05:21","tipo":"paso","detalle":"ZARAGOZA-DELICIAS 10:05 · estimada (sin GPS)"},
    {"t":"15:10:00","tipo":"fin","detalle":"Seguimiento detenido"}
  ]
}
```
`tipo ∈ {inicio, fin, paso, conflicto, fuera_ruta, sin_senal, retraso}`. Tope de 600 entradas por marcha (truncado al añadir). Eventos `fuera_ruta`/`sin_senal`/`retraso` se deduplican (no se repiten en sondeos consecutivos idénticos).

### 4.7 Preferencias y otras claves

| Clave | Almacén | Valor | Notas |
|---|---|---|---|
| `ebula_auth_v1` | sessionStorage | `'1'` | Sesión autenticada por PIN. Se pierde al cerrar pestaña. |
| `ebula_v2` | localStorage | `{"idx": <number>}` | Preferencias: índice del tren seleccionado. |
| `ebula_pwa_dismissed_v1` | localStorage | `'1'` | El usuario descartó el prompt de instalación PWA. |
| `ebula_dhltv_v1` | localStorage | `{"filename":..., "list":[LTV...]}` | DHLTV cargado (lista parseada). |
| `ebula_adif_v2` | localStorage | JSON ADIF cacheado | Solo si ADIF está activo. |
| `ebula_overlay_collapsed` | localStorage | `'0'` / `'1'` | Estado del overlay en el mapa. |
| `ebula_theme` | localStorage | `'dark'` / `'light'` | Tema. Default `dark`. |
| `ebula_punches_v2` | localStorage | ver 4.5 | Marcas. |
| `ebula_marksrc_v1` | localStorage | ver 4.5 | Fuente de marcas. |
| `ebula_gpslog_v1` | localStorage | ver 4.6 | Log GPS. |

> Convención: prefijo `ebula_` (heredado, codename interno del autor original) + sufijo `_vN` para invalidación al cambiar schema.

---

## 5. Funcionalidades clave

> **No existen en HT-Iryo:** Keycloak (login federado), virtual scroll del calendario. Esos dos pertenecen al proyecto IVU `shift_sync`. Aquí, en cambio, hay un login PIN trivial (5.1).

### 5.1 Login por PIN (no Keycloak)
- Overlay `#login-overlay` cubre toda la pantalla mientras `<body>` lleva la clase `locked`.
- `const PASS = '8412'` hardcodeado en JS (≈ línea 744). Comparación directa.
- Si correcto → `sessionStorage.setItem('ebula_auth_v1','1')`, se quita `locked` y se oculta el overlay.
- Input con `inputmode="numeric"`, `autocomplete="off"` (no asociarlo con gestores de contraseñas).
- **Seguridad:** el PIN es texto plano en JS. No es seguridad real, es un disuasorio. Para Iryo-Studio: o se asume el mismo modelo, o se sube a un esquema mejor (token, login real, etc.).

### 5.2 Prompt de instalación PWA
- Escucha `beforeinstallprompt`, almacena el evento, muestra un diálogo propio (rol `dialog`) explicando ventajas + botón Instalar.
- Si el usuario descarta → `localStorage.setItem('ebula_pwa_dismissed_v1','1')` y no se vuelve a mostrar.
- Service Worker se registra en `./sw.js`. Error silencioso (`.catch(()=>{})`).

### 5.3 Render del Horario / marcha
- `renderRows()` borra `<tbody>` y lo reconstruye fila a fila.
- Cada fila lleva `data-idx="<i>"` (índice en `march.s`).
- Columnas actuales: km, VMáx, Dependencia, Teórica, Com, Real. (La columna BLQ fue eliminada por upstream `ba67b48`.)
- VMáx (y BLQ cuando existía) se renderiza con `rowspan` por tramos contiguos del mismo valor (`computeSpans`, admite huecos `mergeAcrossEmpty`).
- Filas BCE/CDI (`_l010cdi`) en color violeta tenue, sin botón "marcar".
- Paradas comerciales (`c`) y origen/destino marcadas con `com-stop` (fondo verde) y `<span class="stop-marker">`.
- Tras renderizar se llama a `applyPunches()` para inyectar marcas guardadas y a `updatePosition()`.
- **Wrapper LTV** (ver 5.7) decora la tabla con filas extra y resaltado VMáx amarillo.

### 5.4 Marcaje real ("punteo")
Tres caminos comparten el almacén `punches` + `markSource`:

- **Manual** — clic en "marcar". `punchAt(idx)` toma la hora actual (`nowMin()` o `manualOffsetMs`), formato HH:MM, fuente `'manual'`.
- **GPS** — `HTIryo.setMark(idx, hhmm, 'gps')` desde `autoMark()` en gps-tracking.js cuando la proyección confirma el paso.
- **Estimada** — `HTIryo.setMark(idx, hhmm, 'est')` desde `estimateMark()` cuando expira la ventana sin señal. Se muestra con prefijo `~`.

Operaciones:
- Borrado individual: clic en la "×" (`clearPunch(idx)`).
- Borrado masivo: botón "Reset punteo" (`clearAllPunches()`, con confirmación).
- Toda mutación de marcas limpia `provisionalDelay = null` (ver 5.6).

### 5.5 Cálculo de posición / retraso
- `updatePosition()` corre cada segundo (ticker de 1 s).
- Encuentra `lp` = última estación marcada. `delayMin = real(lp) − tm(lp)` (con normalización por cruce de medianoche: `if(diff<-720) diff+=1440; if(diff>720) diff-=1440`).
- `effTm(i) = tm(i)` si `i < lp`, `tm(i) + delayMin` si `i ≥ lp` — solo se extrapola hacia adelante.
- Determina `activeIdx`, `prevIdx`, `nextIdx` comparando con `nowMin()`.
- **Con el GPS activo, anclaje a la última marca real:** `activeIdx = lp` (no extrapola por reloj). Decisión explícita del usuario: *"el programa no puede imponer lo que estima"*.
- Si hay retraso confirmado por GPS (`provisionalDelay`, ver 5.6), `#delta` muestra ese valor con prefijo `~`.
- Recuadro de posición `#position-box` (chincheta amarilla) con dos hijos:
  - `#position-info` — `📍 <b>ESTACIÓN</b> (teórica HH:MM → prevista HH:MM) · VMáx N km/h` (lo escribe `updatePosition`).
  - `#gps-subline` — estado GPS (lo escribe gps-tracking.js).
  Visibilidad gestionada por `refreshPositionBox()`.
- Auto-scroll suave a la fila activa si está fuera del viewport (a menos que `window._suppressAutoScroll` esté activo).

### 5.6 Seguimiento GPS (`gps-tracking.js`)

Módulo autónomo dependiente solo de `window.HTIryo`. Núcleo verificado en tren real — **NO TOCAR la detección al integrar**.

**Comportamiento (v1):**
- El GPS NO vigila entre estaciones. Cerca de cada estación se abre una "ventana" calculada con la hora efectiva (teórica + retraso acumulado): se abre en `effTime − LEAD_MIN (2 min)`.
- Dentro de la ventana se sondea el GPS cada `POLL_MS = 30 s`. Si la posición proyectada sobre la ruta (`projectGps`) indica que se pasó la estación, se marca real con la hora actual. Si pasan `GIVEUP_MIN (3 min)` desde la hora efectiva sin señal, se rellena con hora estimada (`fmtHM(effTime)`, fuente `est`).
- Fuera de ventana → `pollTick` solo mira el reloj. **Cero gasto de GPS**.

**Parámetros (top del módulo):**
- `POLL_MS = 30000` — cada cuánto se ejecuta el ciclo.
- `LEAD_MIN = 2` — apertura de ventana antes de la efectiva.
- `GIVEUP_MIN = 3` — margen tras la efectiva sin señal → estimación.
- `OFF_ROUTE = 1e-3` — umbral (grados²) para descartar "fuera de ruta".
- `ARM_LEAD = 3` — minutos antes de la hora de salida para "armar" el botón.

**Funciones clave (todas en `gps-tracking.js`):**
| Función | Qué hace |
|---|---|
| `GeoSource.getCurrent()` | Capa aislada → `navigator.geolocation.getCurrentPosition` con `enableHighAccuracy:true`, `timeout:10000`, `maximumAge:0`. **Sustituir solo esto para Capacitor.** |
| `isMarkable(m,i)` | `i>0 && s.n && COORDS[s.n] && s.tm!=null && !s._l010cdi`. |
| `currentDelta()` | Retraso/adelanto actual a partir de la última marca registrada. |
| `effTime(idx)` | `tm + currentDelta()`. |
| `normNow(eff)` | Hora actual normalizada para comparar con `eff` cruzando medianoche. |
| `recomputeNext()` | Primera estación markable sin marcar → `gpsNextIdx`. |
| `projectGps(lat,lng)` | Mejor segmento de la ruta + índice de la última dependencia superada. `null` si está fuera de ruta. |
| `pollTick()` | Ciclo principal cada 30 s. Abre/cierra ventana, llama al GPS, decide marcar / estimar / esperar. |
| `autoMark(idx, skipped)` | Registra una marca GPS o estimada (si se saltó alguna). Conflicto manual → conserva. |
| `estimateMark(idx)` | Rellena con `tm + delta` cuando expiró la ventana sin señal. |
| `startTracking()` / `stopTracking()` | Lifecycle. Wake Lock, poll timer, log inicio/fin. |
| `checkDeparture()` | Arma el botón verde pulsante a partir de `ARM_LEAD` antes de la salida. |
| `logEvent(tipo,detalle,dedup)` | Anota en `ebula_gpslog_v1` con deduplicación. |

**Mejoras añadidas en la versión de David:**
- *Mejora 1 — Retraso creciente:* cuando el GPS confirma que el tren sigue sin llegar a la siguiente estación y ya pasó su hora prevista, se publica un retraso provisional (`prov = currentDelta() + (nowM − eff)`) vía `API.setProvisionalDelay(prov)`. Se ve creciendo en `Δ marcha` (con prefijo `~`) y en la sublínea GPS. La marca real lo sustituye al pasar; cualquier mutación de `punches` lo borra.
- *Mejora 2 — Registro automático:* cada marca y evento se anota en `localStorage['ebula_gpslog_v1']` (ver 4.6). Sin pantalla; consulta vía DevTools por ahora.

**UI (en la cabecera del Horario):**
- Botón `#gps-btn` en `.top-row`, lado opuesto al PDF (botón PDF eliminado por upstream `ba67b48`; el GPS sigue en su sitio).
- Sublínea `#gps-subline` dentro de `#position-box` (chincheta amarilla). Texto pequeño con chip de color: verde (`.ok`) / naranja (`.warn`) / blanco (base). Overrides para tema claro.
- Estados del botón: base ("▶ Iniciar seguimiento GPS"), `armed` (verde pulsante a partir de `ARM_LEAD` min antes de la salida), `tracking` (rojo "■ Parar seguimiento").
- Wake Lock activo durante el seguimiento. Si la app pasa a 2.º plano y vuelve, muestra una sublínea tocable "⚠ En 2.º plano: el seguimiento pudo pausarse — toca para reactivar".

**API que `index.html` expone a `gps-tracking.js`:** `window.HTIryo`:
| Miembro | Tipo | Uso |
|---|---|---|
| `getMarch()` | función | Marcha actual. |
| `COORDS`, `LINES` | objeto | Diccionarios geográficos. |
| `getPath(m)` | función | Segmentos de ruta cacheados. |
| `snapToPolyline([lat,lng], pts)` | función | Proyección de punto sobre polilínea. |
| `nowMin()` | función | Hora actual en minutos. |
| `getTickKey()` | función | Clave de marcha para localStorage. |
| `refreshPositionBox` | función | Recalcula visibilidad del `#position-box`. |
| `setProvisionalDelay(min)` | función | Mejora 1 — publica retraso creciente. |
| `getMark(idx)` / `getMarkSource(idx)` | función | Lee la marca y su fuente. |
| `setMark(idx, hhmm, source)` | función | Escribe marca + persiste + UI. Limpia `provisionalDelay`. |
| `onMarchaChange(cb)` | función | Subscripción a cambios de tren. |
| `_dispatchMarchaChange()` | función | Internal — disparado al cambiar de tren. |

**Y a la inversa, gps-tracking.js expone en `window.HTIryo`:**
| Miembro | Uso desde index.html |
|---|---|
| `isTracking()` | `updatePosition` lo usa para no extrapolar por reloj. |
| `logManualMark(idx)` | `punchAt` lo invoca cuando el seguimiento está activo. |

### 5.7 DHLTV — Limitaciones Temporales de Velocidad

- Sube un PDF DHLTV oficial → `parseLTVPdf()` con pdf.js.
- El PDF está rotado 90°: cada registro es una columna a una X distinta, y los campos están a Y fijas dentro de cada columna (cabecera línea ≈ Y11, trayecto ≈ Y66, vía ≈ Y193, km.ini ≈ Y206, km.fin ≈ Y237, vmáx ≈ Y274, motivo ≈ Y295).
- Anclas: códigos LTV `(NNNNNN)` (a Y ≈ 11) y cabeceras `LÍNEA NNN` (mismo Y). Procesados en orden de X; cada cabecera actualiza `currentLine`, cada código le hereda.
- Estado: `LTV_LIST` (array global) + caché en `ebula_dhltv_v1` con `filename` para mostrar el nombre.
- Render: tabla agrupada por línea en la pestaña DHLTV.
- **Integración con el Horario:** al renderizar, se inyectan filas LTV bajo las paradas afectadas cuyo tramo km solape con el rango de la LTV y cuya línea esté en `segLines[i]` y entre las dominantes del tren. Cada LTV se muestra una sola vez por tren (en el primer tramo que la cubre).
- Mejoras del porte `ba67b48`: celda VMáx amarilla cuando hay LTV, badge "NO INCORP. SISTEMA" para LTVs aún no incorporadas al sistema embarcado.

### 5.8 Mapa (oculto)
Inicialización lazy en el primer cambio a la pestaña. Leaflet con OpenStreetMap. Funciones clave **que el GPS sigue necesitando** aunque la pestaña esté oculta:
- `buildMarchaPath(march)` — produce los segmentos de ruta del tren proyectando cada parada sobre las líneas LAV.
- `snapToPolyline([lat,lng], pts)` — proyecta un punto sobre una polilínea; devuelve `{idx, t, dist}`.
- `getPath(m)` — caché de `buildMarchaPath` por `m.t|m.o→m.d`.
- `trainPositionAt(m, t, opts)` — interpola la posición del tren en un instante t.

El GPS depende de las tres primeras.

### 5.9 ADIF tiempo real (oculto)
Conexión SignalR a `https://info.adif.es/InfoStation` por estación, hub `ECM-<código>`. Métodos `JoinInfo` + `GetLastMessage`, evento `ReceiveMessage`. Filtra solo trenes Iryo (`isIryo()`). Cola con 3 workers en paralelo, timeout 12 s, fallback a códigos alternativos. Cachea respuestas válidas en `ebula_adif_v2`. Refresco automático cada 60 s si la pestaña activa es consumidora (`schedule`/`adif`/`map`). Inyecta badges "VÍA N" y "retraso ±N min" en las filas del horario (`patchAdifBadges` — actualización in-place sin reconstruir la tabla, anti-flicker).

Ya no se carga la librería SignalR (eliminada en `ba67b48`); el código queda dormido.

### 5.10 Tema claro / oscuro
- Toggle `bindTheme()` con icono 🌙/☀.
- `body.light` activa una segunda paleta CSS (todas las reglas relevantes tienen su `body.light` correspondiente).
- Persistencia en `localStorage['ebula_theme']`. Default `dark`.

---

## 6. Decisiones de diseño históricas

Por orden cronológico (ver `git log` para SHAs):

| # | Cuándo | Problema | Solución | Archivos / commit |
|---|---|---|---|---|
| 1 | 20-05 | Punto de partida. App original sin tocar. | Commit baseline para tener punto de reversión. | `1d6f41e` |
| 2 | 20-05 | El seguimiento del horario solo se hacía por reloj; sin marcaje manual la posición no era fiable. | Añadir seguimiento GPS de la marcha como módulo separado para no manchar `index.html`. API mínima `window.HTIryo`. Capa `GeoSource` aislada para futura Capacitorización. | `2e32584` |
| 3 | 20-05 | Sin tren real no se podía probar el GPS. | Modo prueba (checkbox que ignora ventana horaria). *Eliminado luego.* | `f544c80` |
| 4 | 20-05 | Con el delta de prueba negativo grande, `updatePosition()` saltaba al final del recorrido (Sevilla). | Cuando `HTIryo.isTracking()` es true, `activeIdx = lp` (última marca real). Cero extrapolación por reloj. | `0c6b0e0` |
| 5 | 20-05 | La barra GPS inferior tapaba la última estación al hacer scroll. | `padding-bottom:72px` en `#schedule-pane`. | `a1caf59` |
| 6 | 22-05 | Texto del estado se truncaba en la barra; dos botones peleaban por el ancho. | Barra en dos filas + línea de coordenadas debug. | `8190673` |
| 7 | 22-05 | Tras probar en tablet, la barra inferior era intrusiva y el modo prueba sobraba. | UI del GPS a la **cabecera**: botón en `.top-row` lado opuesto al PDF; estado en sublínea dentro de `#position-box`; modo prueba y barra inferior eliminados. Toda la lógica de detección intacta. | `fb24c4f` |
| 8 | 22-05 | Si paras en una estación con señal de salida cerrada, el retraso no crecía hasta que GPS detectara la siguiente. | **Mejora 1:** retraso provisional creciente vía `setProvisionalDelay`. Se muestra en `Δ marcha` y sublínea con `~`. | `08443bb` |
| 9 | 22-05 | Útil tener un registro del recorrido. | **Mejora 2:** log automático en `ebula_gpslog_v1` (marcas + eventos). | `0871b6e` |
| 10 | 22-05 | Forzar invalidación tras los cambios visuales/GPS. | `CACHE_NAME → ebula-v7`. | `fb27124` |
| 11 | 25-05 | Sondeo cada 15 s gasta batería en servicios largos. | `POLL_MS = 30000` (30 s). Detección hasta 30 s tarde; irrelevante para `HH:MM`. | `6aa8e6c` |
| 12 | 25-05 | No perder los cambios del autor original sin romper el GPS. | `git remote add upstream` + `UPSTREAM_SYNC.md` (marcador + historial). Chat dedicado para no contaminar el resto. | `8d15c06` |
| 13 | 25-05 | Primer porte real de upstream `ba67b48`: el autor quitó SignalR, jsPDF, columna BLQ, botón PDF, pestañas ADIF y Mapa; mejoró LTV. | Aplicado con fusión a tres bandas. Dos conflictos resueltos a mano para conservar el GPS. Horarios actualizados de paso. | `64d427a` |
| 14 | 27-05 | El verde claro `.ok` no se diferenciaba bien del amarillo del recuadro. | Sublínea como chip: `.ok` verde con fondo translúcido, `.warn` naranja con fondo translúcido, base blanco. Overrides claro. | `1ab6e38` |

---

## 7. Bugs históricos resueltos

| Bug | Síntoma | Causa raíz | Fix |
|---|---|---|---|
| Salto a Sevilla con GPS activo | Al activar GPS en modo prueba, el indicador saltaba al final del recorrido. | `updatePosition()` extrapolaba `activeIdx` por reloj con un delta enorme. | Anclaje a `lp` cuando hay tracking GPS (`0c6b0e0`). |
| Última estación tapada | La barra GPS fija inferior tapaba la última fila. | Barra `position:fixed` sin hueco en el pane. | `padding-bottom` en `#schedule-pane` (`a1caf59`). |
| Texto cortado en la barra GPS | `text-overflow:ellipsis` recortaba mensajes largos. | Barra en una sola fila peleando con dos botones. | Barra en dos filas; después, UI movida a la cabecera. |
| Cruce de medianoche en ventanas GPS | Las ventanas no abrían en trenes que cruzan 00:00. | Comparación directa `nowMin() vs effTime` sin normalizar. | `normNow(eff)` ajusta n hasta caer en ±720 min de `eff`. |
| Marca manual sobrescrita por GPS | Tras puntear a mano, el GPS la cambiaba. | `autoMark` no comprobaba la fuente. | Comprobar `getMarkSource(idx) === 'manual'` y conservar. |
| Punches colisionando entre PDFs | Mismo número de tren en dos PDFs (grupos) sobrescribía marcas. | `tickKey` no incluía el grupo. | `tickKey = curGrp + '|' + t + '|' + o + '→' + d`. |
| Recuadro de posición vacío visible | `<span>` quedaba como un cuadro amarillo vacío. | `:empty` no funciona con dos hijos. | `refreshPositionBox()` oculta el wrapper si ambos hijos están vacíos. |
| Aviso de 2.º plano se pisaba | Tras `setStatus(...) + showAction(...)` solo se veía la acción. | Sublínea única gestionada por la última llamada. | `showAction` único con label completo "⚠ En 2.º plano: ... toca para reactivar". |
| Conflicto en porte de upstream | `ba67b48` tocaba el CSS del botón PDF y la cabecera, justo donde el GPS añadió cosas. | Diff aplicado a tres bandas chocaba con las modificaciones GPS. | Resueltos a mano conservando el GPS; documentado en `UPSTREAM_SYNC.md`. |

---

## 8. Limitaciones conocidas

- **PIN en texto plano.** `'8412'` visible en el JS; cualquiera con DevTools entra. Disuasorio, no seguridad.
- **GPS solo cerca de estaciones.** No se detecta la posición entre paradas; el indicador queda anclado a la última marca real.
- **Estimaciones encadenadas se desvían.** Si varias estaciones seguidas se rellenan como estimadas (sin GPS), el retraso usado es el de la última estimada — el error se acumula hasta que el GPS engancha una estación real.
- **Solo funciona en primer plano con pantalla encendida.** El Wake Lock mantiene la pantalla; si la pestaña pasa a 2.º plano (otra app, otra pestaña) el sondeo se pausa. Al volver se ofrece "reactivar". Para background hace falta Capacitor + plugin nativo.
- **El timetable es estático embebido.** Los horarios están en `<script id="data">` dentro del HTML. Cualquier cambio del autor original implica republicación; no hay una capa de datos viva.
- **ADIF y Mapa están dormidos.** El autor original eliminó SignalR; el HTML y JS siguen pero no funcionales hasta restaurar la dependencia.
- **DHLTV depende del PDF rotado 90°.** Si el formato oficial cambia (posiciones X/Y), `parseLTVPdf` se rompe silenciosamente.
- **Sin offline 100%.** Leaflet, pdf.js y fuentes (CDN) no están precacheadas; en zona sin cobertura solo va lo embebido + service worker.
- **Sin tests.** No hay suite automatizada. Verificación manual (DevTools + preview Netlify).
- **Service Worker simple.** Cache-first puro; ningún stale-while-revalidate ni purge por tamaño.

---

## 9. Convenciones de código y patrones

- **Un único IIFE grande** en `index.html` envuelve casi todo el JS; las variables internas no contaminan `window`.
- **Sin frameworks.** DOM API directa. `document.getElementById` (alias `$(id)`). `addEventListener`. Mutaciones por `innerHTML` (con `escapeHtml()` para datos externos).
- **`var` en `gps-tracking.js`, `const`/`let` en `index.html`** (mezcla heredada; el módulo nuevo se hizo en `var` por conservadurismo).
- **Estado global mínimo:** `march`, `curIdx`, `curGrp`, `punches`, `markSource`, `provisionalDelay`, `LTV_LIST`, `mapInitialized`, etc. Todo dentro del IIFE.
- **Funciones `function nombre(){}`** (declaraciones, hoist), no expresiones. Permite llamar a `refreshPositionBox()` antes de su definición.
- **Persistencia con prefijo `ebula_`** + sufijo `_vN` para invalidación al cambiar schema.
- **Estilos en `<style>` inline en `index.html`.** Tema dark por defecto; cada regla relevante tiene su gemela `body.light .X`.
- **Commits en español** con prefijo convencional (`feat`, `fix`, `perf`, `chore`, `style`) y co-autor Claude.
- **Un commit por bloque** de cambios para poder revertir sin tocar lo demás.
- **`updateHeaderOffset()`** mide el alto del `<header>` fijo y lo expone como `--header-offset`, que `body.tab-schedule` usa para no tapar la tabla. Se llama siempre que el header cambia de tamaño.
- **`requestAnimationFrame` + `setTimeout`** para medir el header tras el primer paint.
- **Comentarios en español** abundantes, sobre todo en zonas frágiles.
- **El módulo GPS no toca el DOM más allá de los dos elementos que index.html le da** (`#gps-btn`, `#gps-subline`). Si Iryo-Studio mueve esos elementos, gps-tracking.js sigue funcionando mientras los `id` se mantengan.

---

## 10. TODOs heredados

Cosas habladas/diseñadas que no se implementaron:

- **Consulta y exportación del log GPS.** Hoy solo se guarda en localStorage. Se diseñó dejar la consulta para fase posterior (pantalla en la app + botón export PDF/texto). Datos ya están en `ebula_gpslog_v1`.
- **GPS v2: estimación entre estaciones por VMáx + LTV.** Se valoró y se descartó (complejidad alta para beneficio limitado en HH:MM). La idea: entre dos estaciones, usar `s.v` salvo donde la LTV imponga una velocidad inferior, y refinar la ETA.
- **Avisos de proximidad a LTV.** Vibración/sonido al acercarse a una limitación. Descartado entonces (*"nos enteramos por otra vía"*), pero útil si Iryo-Studio quiere ir más allá.
- **Resumen de servicio al cerrar marcha.** PDF con teórico vs real + evolución del retraso por estación. jsPDF ya no se carga (upstream lo quitó); habría que reincorporar.
- **Offline real (precachear CDN libs).** Descartado entonces porque *"lo que necesita red se mira a posteriori"*; en Iryo-Studio puede tener sentido reabrir.
- **Notificación / auto-aviso de cambios upstream.** Hoy es bajo demanda (chat dedicado). Una rutina cron que avise sería más cómoda.
- **Robustez / UX que quedó fuera:**
  - Tabla ADIF se redibujaba entera cada 60 s y perdía el scroll.
  - Botón "marcar" en móvil con fuente de 9 px (sub-óptimo táctil).
  - `ticker` y `armTimer` corren siempre, también en otras pestañas (batería).
  - Service Worker no precachea las librerías CDN.
- **Mejoras de seguridad:** PIN servidor-side, JWT, o como mínimo ofuscación.
- **Reactivación opcional de ADIF y Mapa.** El código sigue dormido en `display:none`. Restaurar SignalR y los botones lo reactiva; decisión a tomar en Iryo-Studio.

---

## Anexo — Para Iryo-Studio: cómo integrar HT como módulo

Resumen accionable (no exhaustivo):

1. **Aislar el dominio.** Lo que es HT-Iryo (horarios, marcaje, GPS, DHLTV) puede vivir bajo un namespace `iryostudio.modules.ht`.
2. **El JSON embebido** (`data`, `coords`, `lines`, `station-lines`) puede salir a archivos separados (`ht-data.json`, etc.) y cargarse con `fetch` al arrancar el módulo. Reduce mucho el tamaño del HTML.
3. **El módulo GPS** ya está aislado y es portable: solo necesita los métodos de `HTIryo` (rebautícense `IryoStudio.HT`).
4. **Mantener `tickKey` y los formatos de localStorage** o migrar de golpe (con un migrador que lea las claves `ebula_*` y las pase a las nuevas). Hay usuarios con punteo histórico que se perdería sin migración.
5. **El header y el recuadro de posición** son piezas reutilizables; en Iryo-Studio puede ser un componente "barra de marcha" cuando el módulo HT está activo.
6. **No tocar la detección GPS.** Mantener `projectGps`, `snapToPolyline`, `pollTick`, `autoMark`, `estimateMark`, `normNow`, `currentDelta` con la firma y comportamiento actuales. Verificado en tren real.
7. **Mantener el seguimiento upstream** (`UPSTREAM_SYNC.md` + remoto `upstream`) o decidir explícitamente que se rompe el cordón umbilical con `deiividmz/deiividmz.github.io`.
