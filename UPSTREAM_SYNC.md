# Sincronización con el repositorio original

Este archivo registra el seguimiento del repositorio **original** de HT Iryo
(`github.com/deiividmz/deiividmz.github.io`, remoto `upstream`, rama `main`) y
qué cambios de su autor se han portado a la versión de David.

## Estado actual

- **Último commit upstream revisado/portado:** `35961fc` — *Nuevos Horarios* (01-06-2026)
- **Marcador de baseline:** el commit `54bb762` coincidía exactamente con el
  baseline de David `1d6f41e`. El seguimiento de cambios nuevos se hace ahora
  desde `35961fc`.

## Cómo comprobar si hay cambios nuevos

1. `git fetch upstream`
2. `git log 35961fc..upstream/main --oneline`
3. `git diff 35961fc upstream/main -- index.html sw.js manifest.webmanifest`

## Regla crítica

NUNCA portar cambios que toquen el código de detección del GPS
(`gps-tracking.js` y las partes GPS de `index.html`). Si un cambio de upstream
cae sobre esa lógica, NO se aplica: se avisa a David y se resuelve caso a caso.

## Historial de portes

| Fecha porte | Commit(s) upstream | Qué se portó | Notas |
|-------------|--------------------|--------------|-------|
| 2026-05-22  | (baseline `54bb762`) | Punto de partida del seguimiento | El baseline de David ya equivale a este commit |
| 2026-06-01  | `35961fc`          | Actualización de horarios de trenes (solo datos JSON, sin cambios de código) | Aplicado también a Iryo-Studio |
| 2026-05-22  | `ba67b48`          | Quitar columna Blq; quitar botón/función PDF y librerías jsPDF+SignalR; ocultar pestañas ADIF y Mapa; agrandar letra de la tabla; mejoras LTV (celda VMáx amarilla + badge "NO INCORP. SISTEMA"); conservar caché ADIF si todas las estaciones fallan; borrado automático de datos al cerrar; retoque texto "Uso web"; datos del horario actualizados | Portado con fusión a 3 bandas. 2 conflictos (CSS `pdf-btn`/`gps-btn` y botones de cabecera) resueltos a mano conservando el GPS. GPS verificado intacto. Mejoras LTV no probadas en vivo (requieren cargar un PDF de DHLTV). |
