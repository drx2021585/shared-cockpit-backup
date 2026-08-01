/**
 * El router de casa donde se escribio esto no expone UPnP, asi que el camino
 * SOAP se verifica contra un IGD de mentira que habla el mismo protocolo. Lo
 * que se prueba es lo que puede romperse en silencio: encontrar el servicio
 * WAN en el XML, armar el AddPortMapping con la IP interna correcta y leer la
 * IP publica de la respuesta.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import upnp from "../../apps/desktop-ui/electron/upnp.cjs";

const EXTERNAL_IP = "203.0.113.77";

function fakeIgd(): Promise<{ server: Server; location: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      const { port } = server.address() as { port: number };
      res.setHeader("Content-Type", "text/xml");
      res.end(`<?xml version="1.0"?><root><device><serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/nope</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
      </serviceList></device></root>`.replace("PORT", String(port)));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push(body);
      res.setHeader("Content-Type", "text/xml");
      if (body.includes("GetExternalIPAddress")) {
        res.end(`<?xml version="1.0"?><s:Envelope><s:Body><u:GetExternalIPAddressResponse>
          <NewExternalIPAddress>${EXTERNAL_IP}</NewExternalIPAddress>
        </u:GetExternalIPAddressResponse></s:Body></s:Envelope>`);
        return;
      }
      res.end(`<?xml version="1.0"?><s:Envelope><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, location: `http://127.0.0.1:${port}/rootDesc.xml`, calls });
    });
  });
}

test("mapPortAt abre el puerto y devuelve la IP publica", async () => {
  const { server, location, calls } = await fakeIgd();
  try {
    const result = await upnp.mapPortAt(location, { port: 8787, internalAddress: "192.168.1.100" });

    assert.equal(result.ok, true);
    assert.equal(result.externalIp, EXTERNAL_IP, "la IP publica sale del router, no de un servicio externo");
    assert.equal(result.service, "urn:schemas-upnp-org:service:WANIPConnection:1");

    const addCall = calls.find((body) => body.includes("AddPortMapping"));
    assert.ok(addCall, "tiene que haberse pedido el mapeo");
    assert.match(addCall!, /<NewExternalPort>8787<\/NewExternalPort>/);
    assert.match(addCall!, /<NewInternalClient>192\.168\.1\.100<\/NewInternalClient>/);
    assert.match(addCall!, /<NewLeaseDuration>0<\/NewLeaseDuration>/, "sin caducidad: la sesion puede durar horas");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("un router sin servicio WAN se reporta, no revienta", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/xml");
    res.end(`<?xml version="1.0"?><root><device><serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/x</controlURL></service>
    </serviceList></device></root>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  try {
    const result = await upnp.mapPortAt(`http://127.0.0.1:${port}/d.xml`, { port: 8787, internalAddress: "192.168.1.100" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /servicio WAN/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("localAddressTowards devuelve la IP de la interfaz que sale a la red", async () => {
  const address = await upnp.localAddressTowards();
  assert.match(String(address), /^\d+\.\d+\.\d+\.\d+$/);
  assert.notEqual(address, "127.0.0.1", "no puede ser loopback: es la IP que ve el otro jugador");
});
