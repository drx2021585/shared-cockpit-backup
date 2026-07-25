# Decisión: reemplazar SQLite local por PostgreSQL compartido (Supabase)

## Contexto

`server/api` usaba SQLite (`node:sqlite`) con un archivo local por máquina
(`server/api/data/shared-cockpit.db`). Cada piloto que quería jugar corría su
propio proceso de servidor en su propia computadora. Un amigo que intentaba
unirse con un código de sesión recibía "No session found with that code"
porque su servidor local nunca había visto la sesión — vivía en el SQLite del
host, en otra máquina, en otra red.

## Qué se hizo

1. **`server/api/src/db.ts`** ahora usa PostgreSQL real vía el paquete `pg`
   (node-postgres), conectando con `DATABASE_URL` (una cadena de conexión
   Postgres estándar; Supabase provee una). No se usa el SDK
   `@supabase/supabase-js` — es una conexión Postgres plana desde el backend
   Express/WS existente, que sigue siendo la única fuente de verdad.
2. El esquema (`aircraft_profiles`, `sessions`, `session_participants`) se
   tradujo a DDL de Postgres válido (`TIMESTAMPTZ NOT NULL DEFAULT now()` en
   vez de `datetime('now')`, `BOOLEAN` en vez de `INTEGER` para flags) y se
   sigue creando con `CREATE TABLE IF NOT EXISTS` al arrancar.
3. Las firmas exportadas de `db.ts` no cambiaron (`syncAircraftProfiles`,
   `listAircraftProfiles`, `createSession`, `getSessionByCode`, `joinSession`,
   `markDisconnected`) — sí cambiaron de síncronas a `async`, porque `pg` es
   asíncrono donde `node:sqlite`'s `DatabaseSync` no lo era. `server.ts` se
   actualizó para `await` cada llamada.
4. Si `DATABASE_URL` no está definida, el servidor falla al arrancar con un
   mensaje explícito — nunca cae a un mock en memoria ni a SQLite. Coherente
   con la filosofía "sin datos de relleno" del proyecto
   (ver `docs/decisiones/operational-real-data.md`).
5. Se agregó `"start"` a `server/api/package.json` para desplegar en Railway
   (que auto-detecta Node y solo necesita un comando de arranque). Se quitó
   la flag `--experimental-sqlite`, ya innecesaria; se mantiene
   `--experimental-strip-types` porque el código sigue siendo TypeScript
   ejecutado directamente por Node.

## Por qué esto (y no solo cambiar la DB)

Cambiar solo la base de datos no habría arreglado el problema si cada piloto
seguía corriendo su propio proceso local — dos procesos distintos, aunque
apunten a la misma DB, no comparten las conexiones WebSocket en memoria
(`connections` Map en `server.ts`) que hacen el relay de señalización en vivo.
La solución real es **una sola instancia desplegada** de `server/api`
(por ejemplo, en Railway) contra **una sola base de datos compartida**
(por ejemplo, Supabase). El WebSocket relay (`relayFlightMessage`,
`broadcastSessionState`) no se tocó — sigue siendo un relay puro entre sockets
conectados al mismo proceso, que es exactamente lo que se necesita ahora que
ese proceso es compartido.

## Qué no se hizo (fuera de alcance)

- No se implementó WebRTC ni ningún transporte peer-to-peer — eso es trabajo
  futuro de Fase 3 según `docs/plan-maestro.md`.
- No se verificó extremo a extremo contra una instancia real de Supabase
  (no había credenciales disponibles al momento de este cambio) ni contra
  Railway (no se puede probar el despliegue desde este entorno). Se verificó
  que el servidor falla correctamente sin `DATABASE_URL` y que el DDL es
  Postgres válido por inspección.
