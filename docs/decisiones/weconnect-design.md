# Decisión: implementar el diseño "WeConnect" (paleta azul fluorescente)

## Contexto

Se importó un handoff de Claude Design (`Diseño con paleta azul fluorescente`)
conteniendo un prototipo HTML/CSS/JS de 7 vistas: Home (landing), Download,
Aircraft, Create a party, Join a party, In cockpit, My profile.

## Decisiones confirmadas con el usuario

1. **Nombre de marca: WeConnect** (el nav del prototipo, no "Shared Cockpit" —
   el nombre del proyecto/repo se mantiene como "Shared Cockpit" a nivel técnico,
   pero la marca visible en la UI es WeConnect).
2. **Reemplaza por completo** el sistema de diseño ámbar/teal anterior (pantalla
   "Inicio" + `CoverageGauge` + `StatusIndicator`) — esos archivos se eliminaron.
3. **Se implementaron las 7 vistas** del handoff, no un subconjunto.

## Qué se recreó vs. qué se corrigió

Se recreó pixel-a-pixel: paleta, tipografía (Inter 300 + JetBrains Mono), layout
de secciones (max-width 1160px, padding 80px, hairlines con índice 01-05),
todos los textos y datos del prototipo.

Se corrigió un bug evidente del export: en la sección "Aircraft support", el
prototipo repetía el label "Adding a new aircraft" dentro de cada iteración del
loop de pasos (5 veces) en vez de mostrarlo una sola vez como encabezado de
sección. Se movió fuera del loop — coincide con el patrón usado en el resto del
documento (ej. "Getting into the same cockpit").

## Qué se añadió (no estaba en el prototipo, pero es necesario para que funcione)

- Interactividad real: navegación por estado (`ViewId`), checkbox de contraseña,
  selector de asiento capitán/primer oficial, botón de recarga de código de
  sesión, toggle de blur de IP — el prototipo tenía estos elementos visualmente
  pero sin lógica completa.
- `usePublicIp` — hook real que llama a la API de ipify (igual que el prototipo)
  para mostrar la IP pública del jugador en Create a party / In cockpit.

## Pendiente

- Conectar `Cockpit.tsx` (ping, sync status, aircraft) al bridge real
  (`ws://localhost:7620`) en lugar de los valores estáticos del diseño.
- Decidir si el checkbox "Use a password" oculta/muestra el campo (implementado)
  se mantiene así o el campo siempre visible como en el prototipo original.
