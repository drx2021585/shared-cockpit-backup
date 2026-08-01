# Plan: conexión directa a través de CGNAT (rendezvous + hole punching)

Estado: **pendiente**, aprobado para después de 0.1.51. Nada de esto está
implementado todavía.

## Por qué

El modo `Direct` de hoy (0.1.51) funciona cuando el anfitrión puede recibir
conexiones entrantes: misma LAN, UPnP disponible, o reenvío de puertos manual.
Eso deja fuera dos casos frecuentes, incluido el del autor de este repo:

- **CGNAT** (5G casero, móvil, satélite): el proveedor comparte una IP pública
  entre muchos clientes. No hay puerto que reenviar. Medido en la red de
  desarrollo: gateway T-Mobile M3000, IP pública `172.59.x.x`, ningún IGD UPnP
  respondiendo a SSDP.
- **NAT estricto / router sin UPnP**: el usuario tendría que configurar el
  router a mano, y muchos no pueden o no quieren.

`Cloud Host` cubre esos casos hoy, a costa de latencia: todo el tráfico pasa por
el servidor de Render.

## Qué se quiere

Conexión directa PC a PC **sin** que el anfitrión abra puertos, usando el
servidor solo para presentar a los dos pares. Es el punto 4 del modelo de
YourControls: *"un servidor en la nube solo para coordinar la sesión e
intercambiar endpoints, no necesariamente para transportar todos los datos"*.

## Cómo

1. **Rendezvous en `server/api`.** Un endpoint nuevo donde cada par publica sus
   candidatos (IP:puerto local, y el par IP:puerto público tal como lo ve el
   servidor) y lee los del otro. El servidor no transporta datos de vuelo, solo
   presenta.
2. **Descubrimiento del endpoint público.** El cliente necesita saber cómo lo ve
   el mundo: STUN (RFC 5389) contra un servidor público, o el propio servidor de
   sesión devolviendo el origen del socket.
3. **Hole punching UDP.** Los dos pares mandan paquetes al endpoint del otro a la
   vez; el primero abre el agujero en su NAT y el segundo entra por él. Funciona
   con NAT de cono; falla con NAT simétrico en ambos lados.
4. **Transporte.** El hole punching es UDP, y el protocolo actual es
   HTTP + WebSocket sobre TCP. Dos caminos:
   - **Barato**: WebRTC DataChannel (ICE/STUN/TURN ya resueltos por el navegador
     de Electron, canales fiables y no fiables incluidos). Encaja con el canal
     confiable/rápido que ya define `packages/protocol`.
   - **Caro**: transporte UDP propio estilo `laminar`, como YourControls.
     Reescribe protocolo, motor de sincronización y bridge.
   **Recomendado: WebRTC.** Electron ya lo trae; evita reimplementar
   fiabilidad, orden y control de congestión.
5. **Respaldo obligatorio.** Con NAT simétrico en ambos lados el hole punching
   no puede funcionar: hay que caer a `Cloud Host` (o a TURN) automáticamente y
   decírselo al usuario, no fallar en silencio.

## Medición: esto NO resuelve la red del autor

Test STUN desde la red de desarrollo (2026-08-01), mismo socket UDP local
contra tres servidores distintos:

| Servidor | Puerto público asignado |
| --- | --- |
| stun.l.google.com | 28230 |
| stun1.l.google.com | 28230 |
| stun.cloudflare.com | 62101 |

Puerto distinto por destino = **NAT simétrico**. El hole punching necesita que
el mapeo sea independiente del destino para poder anunciar un endpoint que
siga siendo válido cuando el otro par escriba; con NAT simétrico el agujero es
impredecible por definición. Sumado al CGNAT (sin puerto propio) y a que la IP
pública rota entre mediciones, en esta red **la conexión directa no es
alcanzable por ningún camino**: ni forwarding, ni UPnP, ni punching.

Consecuencia para el plan: sigue valiendo la pena para usuarios con NAT de
cono, que son mayoría en fibra/cable domésticos, pero **no** hay que
presentarlo como la solución para redes móviles/5G. Ahí el único camino es
relay (TURN), que es funcionalmente lo que ya hace Cloud Host.

## Qué NO hacer

- No borrar `Cloud Host`: es el respaldo cuando esto falla, y falla en un
  porcentaje real de redes.
- No prometer "sin nube nunca": el rendezvous necesita un servidor para la
  presentación inicial, incluso cuando los datos van directos.

## Cómo se comprueba

Un test de integración no alcanza: el hole punching depende del comportamiento
del NAT de cada casa. Hace falta prueba real entre dos redes distintas, y como
mínimo registrar qué candidato terminó ganando (local, público, o respaldo) para
poder diagnosticar cuando falle.
