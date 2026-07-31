# Self-Hosted Relay

Modo soportado desde `v0.1.31`: una PC corre `server/api` y las dos apps de
We Connect apuntan a esa URL en vez del relay hospedado por We Connect.

## Qué resuelve

- Mantiene la arquitectura actual de sesiones, autoridad, ping, snapshots y
  WebSocket.
- Evita depender del relay público de We Connect.
- Funciona bien en LAN.

No es P2P puro: sigue habiendo un relay, pero ahora lo hospeda una de tus PCs.

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

Si todo va bien, el proceso muestra algo como:

```text
Shared Cockpit API real corriendo en http://localhost:8787
WebSocket de sesión en ws://localhost:8787/ws
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

## Cómo volver al relay hospedado

En `Profile`:

1. Marcar `Use the We Connect hosted relay`.

## Notas

- El cliente guarda la URL elegida en `localStorage`.
- Al cambiar de relay, la app invalida y vuelve a pedir el catálogo de
  aeronaves al nuevo backend.
- El feed de auto-update sigue saliendo de GitHub Releases; cambiar el relay de
  sesiones no cambia el canal de actualizaciones.
