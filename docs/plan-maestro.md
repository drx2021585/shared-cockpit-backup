# Plan Maestro — Shared Cockpit

> Fuente: documento original de planificación de Darwin (aviación / MSFS 2020-2024).
> Este archivo es la referencia que usa el orquestador para descomponer sprints.

## Fases y sprints (orden de ejecución)

### Fase 1 — Investigación y pruebas técnicas
Agentes: simconnect-bridge-agent, wasm-agent
Objetivo: confirmar que se puede leer/escribir los controles necesarios.
Resultado: app local que detecta MSFS y controla varios elementos, sin multijugador.

### Fase 2 — Protocolo de sincronización local (Sprint 2)
Agentes: sync-engine-agent, simconnect-bridge-agent
Objetivo: sincronizar dos procesos en la misma computadora sin ciclos de retroalimentación.

### Fase 3 — Red entre dos computadoras (Sprint 3)
Agentes: networking-agent, sync-engine-agent
Objetivo: compartir una aeronave básica a través de internet (WebRTC + relay, reconexión).

### Fase 4 — Primera aeronave completa: Cessna 172
Agentes: aircraft-profiles-agent, wasm-agent, simconnect-bridge-agent
Objetivo: vuelo completo cold-and-dark → shutdown sincronizado.
Estado: perfil inicial creado en `aircraft-profiles/cessna-172/` (pendiente de
validación real contra el simulador).

### Fase 5 — Transferencia y roles (Sprint 4-5)
Agentes: sync-engine-agent (autoridad), frontend-agent (UI de transferencia)
Objetivo: capitán / primer oficial / observador, solicitud y aceptación de controles.

### Fase 6 — Sistema universal de perfiles (Sprint 6)
Agentes: aircraft-profiles-agent, frontend-agent (editor visual)
Objetivo: editor de perfiles con modo aprendizaje, validación automática, firma de paquetes.

### Fase 7 — Primera aeronave comercial compleja
Agentes: aircraft-profiles-agent, simconnect-bridge-agent (interop real vía SDK
oficial de PMDG), wasm-agent (rol secundario, solo si hace falta)
Objetivo: UNA aeronave compleja a la vez. Decisión 2026-07-20: se reemplaza la
recomendación original (FlyByWire A32NX) por la **familia PMDG 737 NG**,
mostrada en la app como una sola entrada: **"PMDG B737 NG"**, con las variantes
600, 700, 800 y 900 (pendiente confirmar con Darwin si también existe una
variante 900ER como SKU separado, no confirmado en la investigación pública).
Un perfil base compartido + overrides por variante donde el sistema real
difiera. Sigue aplicando: no trabajar varias aeronaves complejas en paralelo —
toda la familia PMDG B737 NG cuenta como una sola aeronave compleja a efectos
de esta regla, no como cuatro/cinco.

Interop confirmada 2026-07-20: PMDG entrega un SDK oficial junto con la
instalación del addon (`PMDG_NG3_SDK.h` + PDF de referencia, en la carpeta de
Documentación del producto), basado en SimConnect Client Data Area
(`EnableDataBroadcast=1` en el INI de opciones). No requiere ingeniería
inversa. Pendiente: Darwin debe proveer esos archivos reales desde su
instalación antes de que simconnect-bridge-agent implemente nada.

### Fase 8 — Beta cerrada
Agentes: qa-agent (liderando), todos los demás en soporte
Objetivo: redes lentas, pérdida de paquetes, crashes, sesiones largas.

## Reglas técnicas no negociables (aplican a todos los agentes)

1. Nunca sincronizar interruptores con TOGGLE crudo — siempre SET_ON/SET_OFF/SET_VALUE + confirmación.
2. Todo cambio recibido de red se marca `origin: remote` y nunca se reenvía como local.
3. Canal confiable vs canal rápido: ver `packages/protocol/README.md`.
4. La posición del avión no es el método principal de sincronización, solo detección de divergencia.
5. Un solo avión complejo a la vez en Fase 7 — cada uno puede tener cientos de controles.

## Alcance del MVP (Shared Cockpit Alpha 0.1)

Incluye: 2 jugadores, Cessna 172, sesiones privadas con código, capitán/primer oficial,
transferencia de controles de vuelo, throttle, flaps, gear, luces, radios básicos,
autopiloto básico, reconexión, snapshot, diagnóstico.

No incluye (explícitamente fuera de alcance del MVP): video/voz integrada, sesiones
públicas masivas, más de 4 jugadores, instructor con fallas, marketplace de pago,
compatibilidad universal de aviones, FMC/MCDU completo, Xbox, meteorología compartida
personalizada, movimiento sincronizado de pasajeros/tripulación.
