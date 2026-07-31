# Self-Hosted Relay

Modo soportado desde `v0.1.31`: una PC corre `server/api` y las dos apps de
We Connect apuntan a esa URL en vez del relay hospedado por We Connect.

## Qué resuelve

- Mantiene la arquitectura actual de sesiones, autoridad, ping, snapshots y
  WebSocket.
- Evita depender del relay público de We Connect.
- Funciona bien en LAN.

No es P2P puro: sigue habiendo un relay, pero ahora lo hospeda una de tus PCs.

## Modos disponibles

- `npm run dev:lan`
  Usa el backend normal de `server/api` y requiere `DATABASE_URL`.
- `npm run dev:direct`
  Levanta un host directo EN MEMORIA, sin Postgres. Es el modo más cercano a
  un host/guest tipo YourControls dentro de la arquitectura actual.

## Requisitos en la PC host

1. Tener este repo y Node instalado.
2. Tener `server/api/.env` con `DATABASE_URL` válido.
3. Permitir el puerto `8787` en el firewall de Windows.

## Arranque del relay host

En la PC anfitriona:

```powershell
cd server/api
npm install
npm run dev:lan
```

O, si quieres un host directo sin base de datos compartida:

```powershell
cd server/api
npm install
npm run dev:direct
```

Si todo va bien, el proceso muestra algo como:

```text
Shared Cockpit API real corriendo en http://localhost:8787
WebSocket de sesión en ws://localhost:8787/ws
```

En modo directo:

```text
Shared Cockpit direct host corriendo en http://0.0.0.0:8787
WebSocket directo en ws://0.0.0.0:8787/ws
```

## Configuración en We Connect

En ambas PCs:

1. Abrir `Profile`.
2. Ir a `Session relay`.
3. Marcar `Use my own relay host`.
4. Escribir la URL de la PC host:

```text
http://<IP-DE-LA-PC-HOST>:8787
```

Ejemplo:

```text
http://192.168.1.20:8787
```

5. Pulsar `Test relay`.
6. Pulsar `Save self-hosted relay`.

## Cuándo usar cada modo

- `dev:lan`
  Si quieres seguir usando el backend completo con Postgres.
- `dev:direct`
  Si quieres que una PC haga de host local y la otra entre directo por IP, sin
  infraestructura externa.

## Cómo volver al relay hospedado

En `Profile`:

1. Marcar `Use the We Connect hosted relay`.

## Notas

- El cliente guarda la URL elegida en `localStorage`.
- Al cambiar de relay, la app invalida y vuelve a pedir el catálogo de
  aeronaves al nuevo backend.
- El feed de auto-update sigue saliendo de GitHub Releases; cambiar el relay de
  sesiones no cambia el canal de actualizaciones.
