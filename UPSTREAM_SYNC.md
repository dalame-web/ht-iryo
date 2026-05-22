# Sincronización con el repositorio original

Este archivo registra el seguimiento del repositorio **original** de HT Iryo
(`github.com/deiividmz/deiividmz.github.io`, remoto `upstream`, rama `main`) y
qué cambios de su autor se han portado a la versión de David.

## Estado actual

- **Último commit upstream revisado:** `54bb762` — *Update index.html* (10-05-2026)
- **Marcador de baseline:** el commit `54bb762` coincide exactamente con el
  baseline de David `1d6f41e` (index.html, sw.js y manifest.webmanifest
  idénticos, 0 líneas de diferencia).

## Cómo comprobar si hay cambios nuevos

1. `git fetch upstream`
2. `git log <marcador>..upstream/main --oneline`
3. `git diff <marcador> upstream/main -- index.html sw.js manifest.webmanifest`

## Regla crítica

NUNCA portar cambios que toquen el código de detección del GPS
(`gps-tracking.js` y las partes GPS de `index.html`). Si un cambio de upstream
cae sobre esa lógica, NO se aplica: se avisa a David y se resuelve caso a caso.

## Historial de portes

| Fecha porte | Commit(s) upstream | Qué se portó | Notas |
|-------------|--------------------|--------------|-------|
| 2026-05-22  | (baseline `54bb762`) | Punto de partida del seguimiento | El baseline de David ya equivale a este commit |
