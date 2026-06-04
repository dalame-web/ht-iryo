# Sincronización con el repositorio original

Este archivo registra el seguimiento del repositorio **original** de HT Iryo
(`github.com/deiividmz/deiividmz.github.io`, remoto `upstream`, rama `main`) y
qué cambios de su autor se han portado a la versión de David.

## Estado actual

- **Último commit upstream revisado/portado:** `4a10109` — *Update index.html* (04-06-2026)
- **Marcador de baseline:** el commit `54bb762` coincidía exactamente con el
  baseline de David `1d6f41e`. El seguimiento de cambios nuevos se hace ahora
  desde `4a10109`.

## Cómo comprobar si hay cambios nuevos

1. `git fetch upstream`
2. `git log 4a10109..upstream/main --oneline`
3. `git diff 4a10109 upstream/main -- index.html sw.js manifest.webmanifest`

## Regla crítica

NUNCA portar cambios que toquen el código de detección del GPS
(`gps-tracking.js` y las partes GPS de `index.html`). Si un cambio de upstream
cae sobre esa lógica, NO se aplica: se avisa a David y se resuelve caso a caso.

## Historial de portes

| Fecha porte | Commit(s) upstream | Qué se portó | Notas |
|-------------|--------------------|--------------|-------|
| 2026-05-22  | (baseline `54bb762`) | Punto de partida del seguimiento | El baseline de David ya equivale a este commit |
| 2026-06-04  | `4a10109`          | Mejoras visuales y de robustez en LTV y Zonas Neutras: rediseño completo del aspecto de las filas LTV (amarillo más intenso, VMáx destacada, bordes y sombras); nueva clase `ltv-affected` que sombrea todas las paradas dentro del rango de una LTV; km de la LTV en spans separados (entrada/flecha/salida); cálculo de dirección en cascada de 3 señales (ventana de stops, par local, fallback global) para LTV y ZN; fila ZN sin texto "ZONA NEUTRA" (solo SVG + rango), km de entrada en la columna Km | Fusión a 3 bandas limpia (0 conflictos). GPS verificado intacto. Aplicado también a Iryo-Studio. |
| 2026-06-02  | `8d5020f` + `ecbc18a` | (8d5020f) Re-mostrar ADIF/Mapa; conexión SignalR `PRE-ECM-` + reconexión automática; Zaragoza Delicias marcada `noData`; código Puertollano corregido a 37700. (ecbc18a) Filas de Zonas Neutras en horario; filtro Vía I/II/Ambas en DHLTV; mejoras en emparejamiento LTV; actualización del JSON de horarios | Fusión a 3 bandas limpia (0 conflictos). GPS verificado intacto. Probado en navegador. Aplicado también a Iryo-Studio. |
| 2026-06-01  | `35961fc`          | Actualización de horarios de trenes (solo datos JSON, sin cambios de código) | Aplicado también a Iryo-Studio |
| 2026-05-22  | `ba67b48`          | Quitar columna Blq; quitar botón/función PDF y librerías jsPDF+SignalR; ocultar pestañas ADIF y Mapa; agrandar letra de la tabla; mejoras LTV (celda VMáx amarilla + badge "NO INCORP. SISTEMA"); conservar caché ADIF si todas las estaciones fallan; borrado automático de datos al cerrar; retoque texto "Uso web"; datos del horario actualizados | Portado con fusión a 3 bandas. 2 conflictos (CSS `pdf-btn`/`gps-btn` y botones de cabecera) resueltos a mano conservando el GPS. GPS verificado intacto. Mejoras LTV no probadas en vivo (requieren cargar un PDF de DHLTV). |
