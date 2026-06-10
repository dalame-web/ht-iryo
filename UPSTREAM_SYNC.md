# Sincronización con el repositorio original

Este archivo registra el seguimiento del repositorio **original** de HT Iryo
(`github.com/deiividmz/deiividmz.github.io`, remoto `upstream`, rama `main`) y
qué cambios de su autor se han portado a la versión de David.

## Estado actual

- **Último commit upstream revisado/portado:** `e33bf85` — *Línea adicional B/dest. (ebula-v75)* (09-06-2026)
- **Nota:** A partir del 07-06-2026 el porte se aplica **solo a ht-iryo**. El repo `Iryo-Studio` queda parado y NO recibe portes nuevos.
- **Marcador de baseline:** el commit `54bb762` coincidía exactamente con el
  baseline de David `1d6f41e`. El seguimiento de cambios nuevos se hace ahora
  desde `e33bf85`.

## Cómo comprobar si hay cambios nuevos

1. `git fetch upstream`
2. `git log e33bf85..upstream/main --oneline`
3. `git diff e33bf85 upstream/main -- index.html sw.js manifest.webmanifest boxann.js`

## Regla crítica

NUNCA portar cambios que toquen el código de detección del GPS
(`gps-tracking.js` y las partes GPS de `index.html`). Si un cambio de upstream
cae sobre esa lógica, NO se aplica: se avisa a David y se resuelve caso a caso.

## Historial de portes

| Fecha porte | Commit(s) upstream | Qué se portó | Notas |
|-------------|--------------------|--------------|-------|
| 2026-05-22  | (baseline `54bb762`) | Punto de partida del seguimiento | El baseline de David ya equivale a este commit |
| 2026-06-09  | 10 commits `fba48a7` → `e33bf85` (ebula-v75) | Renombre de columna "Com" → "Parada"; letra más grande en columnas Parada y Real; nueva clase `td.com.mixto` para paradas con comercial + técnica simultáneas (degradado verde→naranja, formato `5+2`); 3 categorías en la leyenda (Comercial, Técnica, Comercial + Técnica); wrapper flex `.dep-wrap` (nombre + icono "i" lado a lado); línea ADIF a una segunda línea bajo el nombre; retrasos ADIF separados `delay_in` / `delay_out` con etiquetas "Lleg."/"Sal." en estaciones intermedias; función `fmtFecha` limpia el texto del Estado de la Red; retoque modal PUERTOLLANO. Lógica de horario/posición/marcado SIN tocar | Aplicación vía `git apply --3way` (merge-file falló al divergir mucho desde la base). 2 conflictos: 1) `td.actual.punched` con `font-size:15px` + 3 clases `mark-*` del GPS — combinados; 2) showSwVersion — mantenido el display de dos líneas, subido `ORIGINAL_VER` a `'ebula-v75'`. GPS 18/18 marcadores intactos. |
| 2026-06-09  | `b90b96d` + `b5d23c5` | Nueva ventana modal de información de estación (`#st-modal`) con datos por dependencia (vías, punto de parada, salidas, esquemas en imagen): 14 estaciones cargadas (Albacete, Atocha, Barcelona-Sants, Camp de Tarragona, Ciudad Real, Córdoba, Cuenca, Sevilla-Santa Justa, Málaga, Valencia, Zaragoza, etc., y Alacant-Terminal). Trigger al pulsar el icono de paradas comerciales. Cierre con ✕ / fuera del modal / Escape | Fusión 3-bandas con 2 conflictos (1: `provisionalDelay` + nuevo `STATION_INFO`; 2: FALLBACK `ebula-v22.loc` vs `ebula-v57`). Resueltos manteniendo GPS y el sufijo `.loc` del fork. Solo aplicado a ht-iryo. |
| 2026-06-07  | `7e4596d` + `6c65068` + `38e6d7e` + `4fdce49` + `0b5d703` | Corrección LTV PK BIF.MÁLAGA; fix sincronizador; cambios CSS; estilos ZN + botones D/N (día/noche); nuevo botón "Seguimiento ON/OFF" (`#track-toggle`) para alternar el modo de seguimiento por hora; mostrar versión del Service Worker en portada (`#sw-version`); tutorial básico de uso; corrección parámetros ZN L030 | Fusión 3-bandas con 2 conflictos (1: clase de `reset-punches` + botón GPS adyacente; 2: bloque API GPS + nuevos IIFE `bindTrackToggle`/`showSwVersion`). Ambos resueltos conservando todo el GPS. Solo aplicado a ht-iryo (Iryo-Studio queda parado a partir de esta fecha). |
| 2026-06-04  | `8bab2cb` + `b673c40` + `850c7b7` | Nuevo archivo `boxann.js` con datos de anotaciones de recuadro (TASF, LZB, transiciones ERTMS, vías) extraídos de los Libros Horario 306-011-26 y 206-004-26 (66 definiciones, 92 trenes); render de recuadros en la tabla de horario; exportación a CSV; soporte para tren F/T00A-LZB. `sw.js` añade `boxann.js` al PRECACHE | Fusión 3-bandas limpia (0 conflictos). GPS intacto. Archivo nuevo `boxann.js` añadido a ambos repos. Aplicado también a Iryo-Studio. |
| 2026-06-04  | `4a10109`          | Mejoras visuales y de robustez en LTV y Zonas Neutras: rediseño completo del aspecto de las filas LTV (amarillo más intenso, VMáx destacada, bordes y sombras); nueva clase `ltv-affected` que sombrea todas las paradas dentro del rango de una LTV; km de la LTV en spans separados (entrada/flecha/salida); cálculo de dirección en cascada de 3 señales (ventana de stops, par local, fallback global) para LTV y ZN; fila ZN sin texto "ZONA NEUTRA" (solo SVG + rango), km de entrada en la columna Km | Fusión a 3 bandas limpia (0 conflictos). GPS verificado intacto. Aplicado también a Iryo-Studio. |
| 2026-06-02  | `8d5020f` + `ecbc18a` | (8d5020f) Re-mostrar ADIF/Mapa; conexión SignalR `PRE-ECM-` + reconexión automática; Zaragoza Delicias marcada `noData`; código Puertollano corregido a 37700. (ecbc18a) Filas de Zonas Neutras en horario; filtro Vía I/II/Ambas en DHLTV; mejoras en emparejamiento LTV; actualización del JSON de horarios | Fusión a 3 bandas limpia (0 conflictos). GPS verificado intacto. Probado en navegador. Aplicado también a Iryo-Studio. |
| 2026-06-01  | `35961fc`          | Actualización de horarios de trenes (solo datos JSON, sin cambios de código) | Aplicado también a Iryo-Studio |
| 2026-05-22  | `ba67b48`          | Quitar columna Blq; quitar botón/función PDF y librerías jsPDF+SignalR; ocultar pestañas ADIF y Mapa; agrandar letra de la tabla; mejoras LTV (celda VMáx amarilla + badge "NO INCORP. SISTEMA"); conservar caché ADIF si todas las estaciones fallan; borrado automático de datos al cerrar; retoque texto "Uso web"; datos del horario actualizados | Portado con fusión a 3 bandas. 2 conflictos (CSS `pdf-btn`/`gps-btn` y botones de cabecera) resueltos a mano conservando el GPS. GPS verificado intacto. Mejoras LTV no probadas en vivo (requieren cargar un PDF de DHLTV). |
