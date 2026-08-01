# Plan: conexión directa a través de CGNAT (rendezvous + hole punching)

Estado: **pendiente**, aprobado para después de 0.1.51. Nada de esto está
implementado todavía.

## Referencia: cómo funciona `Direct` hoy en YourControls

Esta sección describe el modo `Direct` actual de YourControls como línea base
de referencia. No es la ruta nueva propuesta en este documento: aquí no hay
STUN, TURN ni NAT traversal sofisticado. En `Direct`, el anfitrión abre un
socket UDP local, intenta exponer ese mismo puerto al exterior con UPnP, y el
invitado conecta directo a `IP pública + puerto`.

### Paso a paso

1. **El host abre un socket UDP en un puerto fijo.**
   - En modo directo, el host llama a `Server::start(is_ipv6, port, upnp)`.
   - Ese método crea un socket UDP con `get_socket_duplex(port)` y lo entrega a
     `laminar`.
   - `get_socket_duplex` hace `bind` en `"[::]:<puerto>"` y desactiva
     `only_v6`, así que un solo socket puede aceptar IPv6 y también IPv4
     mapeado si el sistema lo permite.
   - En la configuración local usada como referencia, `config.json` muestra
     `port: 25071`.

2. **Si UPnP está activo, intenta abrir el puerto en el router.**
   - Antes de arrancar la sesión, si `upnp == true` y no es IPv6, ejecuta
     `port_forward(port)`.
   - Ahí detecta la IP LAN del host con un truco de UDP (`connect` a
     `8.8.8.8:80` para IPv4), busca el gateway UPnP con `igd::search_gateway` y
     crea un mapeo UDP del mismo puerto externo e interno.
   - El mapeo usa `lease: 86400` segundos y la descripción `"YourControls"`.
   - En la práctica intenta crear una regla del tipo:
     `UDP 25071 externo -> LAN_IP:25071 interno`.

3. **Si UPnP falla, el host igual arranca.**
   - El resultado de `port_forward` se guarda, pero no aborta el host si falla.
   - Eso significa que la sesión puede quedar escuchando en local aunque el
     puerto no sea alcanzable desde Internet.
   - Ese comportamiento explica errores posteriores del tipo "Please port
     forward or use Cloud Host".

4. **El invitado en `Direct` no usa servidor intermedio.**
   - En conexión directa pura, el cliente llama a
     `Client::start(ip, port, session_id=None)`.
   - Eso entra en `run(..., rendezvous=None, target_address=Some(ip:port))`.
   - Como hay `target_address`, el cliente mete esa dirección en
     `received_address` y envía de inmediato un
     `Payloads::Handshake { session_id: "" }` al host.

5. **El `session_id` en `Direct` está vacío.**
   - En el host directo normal, `Server::start(...)` llama a `run(socket, None)`.
   - Eso inicializa `session_id` como `String::new()`.
   - Entonces el primer handshake del cliente lleva `session_id = ""`, y el
     host espera exactamente eso.
   - La consecuencia importante es que en `Direct` no hay código de sesión real:
     el "secreto" es llegar al puerto correcto del host.

6. **Handshake de establecimiento.**
   - El host recibe `Payloads::Handshake`.
   - Si `session_id` coincide con su `self.session_id`, responde con otro
     `Handshake` al cliente.
   - En `Direct` normal no hay `rendezvous_server`, así que no hace nada más.
   - El cliente, al recibir ese `Handshake` de vuelta, valida el `session_id`,
     marca `connected_address = Some(addr)`, vacía `received_address` y envía
     `InitHandshake { name, version }`.

7. **Autenticación lógica mínima después del handshake.**
   - Después del handshake UDP, el host valida que la versión del cliente
     coincide con la del host y que el nombre no esté repetido.
   - Si todo va bien, le manda al cliente la lista de jugadores ya conectados,
     le manda su propia entrada `PlayerJoined` e inserta al cliente en la
     sesión.

8. **A partir de ahí, todo el tráfico va directo host <-> clientes.**
   - Los `Update` salen del cliente hacia el host.
   - El host los relaya al resto de clientes.
   - No hay relay cloud en esta ruta.

### Protocolo real

- Usa UDP sobre la librería `laminar`.
- Los paquetes se serializan con MessagePack (`rmp-serde`) y se comprimen con
  `zstd`.
- Tipos de entrega:
  - `Handshake`, `RendezvousHandshake`, `PeerEstablished`: `unreliable`
  - `InitHandshake`, `PlayerJoined`, `RequestHosting`, etc.:
    `reliable_ordered`
  - `Update`: `unreliable_sequenced` o `reliable_ordered` según
    `is_unreliable`

### Heartbeats y timeout

- YourControls manda heartbeats manuales cada `0.5 s`.
- `laminar` también tiene heartbeat de `1000 ms`.
- El timeout ocioso de conexión sale de `conn_timeout`; en la configuración de
  referencia está en `5 s`.
- Si durante ~`5 s` no hay tráfico o heartbeat suficiente, la conexión cae.

### Qué exige el port forwarding manual

Para que `Direct` funcione desde Internet, el anfitrión necesita:

- Reenviar **UDP**, no TCP.
- Reenviar el mismo puerto que usa YourControls; en la referencia, `25071`.
- Apuntar la regla al IP LAN actual de la PC anfitriona.
- Regla típica: `UDP 25071 externo -> 192.168.x.y:25071 interno`.

El invitado normalmente no necesita abrir puertos. Solo el anfitrión.

### Qué pasa con CGNAT o NAT estricto

`Direct` suele fallar aunque Windows esté bien configurado cuando:

- el router no soporta UPnP;
- el ISP usa CGNAT;
- no se pueden abrir puertos entrantes reales;
- el firewall del sistema bloquea UDP entrante.

En esos casos, YourControls empuja a otra ruta: `Cloud Host`, relay o hole
punching vía rendezvous.

### Importante: `Direct` no es hole punching

Eso se ve claro en el código:

- `Direct`
  - `Client::start(ip, port, None)`
  - sin rendezvous
  - handshake directo a `IP:puerto`

- Hole punching / self-hosted session
  - `Server::start_with_hole_punching`
  - `Client::start_with_hole_punch(session_id, ...)`
  - usa `RendezvousHandshake`, `AttemptConnection`, `PeerEstablished`
  - el servidor intermedio intercambia endpoints y ambos lados intentan
    perforar NAT

### Resumen técnico corto

`Direct` en YourControls es:

- socket UDP local en el puerto configurado;
- intento opcional de UPnP para abrir ese puerto;
- si no, port forwarding manual;
- cliente envía `Handshake` directo al host;
- host responde;
- cliente manda `InitHandshake`;
- host valida `version` y `name`;
- luego sincronizan por UDP directo.

### Fuentes

- Repositorio: <https://github.com/Sequal32/yourcontrols>
- `yourcontrols-net/server.rs`:
  <https://raw.githubusercontent.com/Sequal32/yourcontrols/refs/heads/master/src/yourcontrols-net/src/server.rs>
- `yourcontrols-net/client.rs`:
  <https://raw.githubusercontent.com/Sequal32/yourcontrols/refs/heads/master/src/yourcontrols-net/src/client.rs>
- `yourcontrols-net/messages.rs`:
  <https://raw.githubusercontent.com/Sequal32/yourcontrols/refs/heads/master/src/yourcontrols-net/src/messages.rs>
- `yourcontrols-net/util.rs`:
  <https://raw.githubusercontent.com/Sequal32/yourcontrols/refs/heads/master/src/yourcontrols-net/src/util.rs>
- `yourcontrols-server/rendezvous.rs`:
  <https://raw.githubusercontent.com/Sequal32/yourcontrols/refs/heads/master/src/yourcontrols-server/src/rendezvous.rs>
- `yourcontrols-server/hoster.rs`:
  <https://raw.githubusercontent.com/Sequal32/yourcontrols/refs/heads/master/src/yourcontrols-server/src/hoster.rs>
- README del servidor:
  <https://github.com/Sequal32/yourcontrols/blob/master/src/yourcontrols-server/README.md>
- Issue donde el autor aclara `25071/udp`:
  <https://github.com/Sequal32/yourcontrols/issues/138>

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
