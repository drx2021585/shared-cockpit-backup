"use strict";

/**
 * Apertura automatica del puerto del direct host en el router (UPnP IGD),
 * igual que hace YourControls: el anfitrion abre un puerto local, intenta
 * mapearlo hacia Internet, y el invitado se conecta a la IP publica + puerto.
 * El trafico va PC a PC; la nube no participa.
 *
 * Sin dependencias: SSDP es UDP plano y el IGD habla SOAP sobre HTTP. Se leen
 * dos campos del XML con regex a proposito — meter un parser de XML entero
 * para <controlURL> y <NewExternalIPAddress> no se paga.
 *
 * Si el router no tiene UPnP (o esta apagado, que es lo normal en muchos ISP)
 * esto devuelve { ok: false, reason } y el que llama debe explicar el reenvio
 * manual de puertos. Nunca lanza: no poder abrir el puerto no es un crash.
 */

const dgram = require("node:dgram");
const { connect } = require("node:net");

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
const WAN_SERVICE_TYPES = [
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

/**
 * IP de esta PC en la interfaz que realmente sale a la red. Un socket UDP
 * "conectado" no manda ningun paquete, solo hace que el SO elija la ruta — es
 * mas fiable que tomar la primera interfaz de os.networkInterfaces(), que en
 * PCs con Hyper-V, VirtualBox o VPN devuelve una IP virtual que el otro
 * jugador no puede alcanzar.
 */
function localAddressTowards(host = "8.8.8.8") {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", () => {
      socket.close();
      resolve(null);
    });
    socket.connect(53, host, () => {
      const address = socket.address().address;
      socket.close();
      resolve(address && address !== "0.0.0.0" ? address : null);
    });
  });
}

function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;

    const finish = (location) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // ya cerrado
      }
      resolve(location);
    };

    socket.on("error", () => finish(null));
    socket.on("message", (message) => {
      const text = message.toString();
      // Responde cualquier dispositivo UPnP de la red (impresoras, TVs); solo
      // interesa el que dice ser un gateway.
      if (!/InternetGatewayDevice|WAN(IP|PPP)Connection/i.test(text)) return;
      const location = /LOCATION:\s*(\S+)/i.exec(text)?.[1];
      if (location) finish(location);
    });

    socket.bind(() => {
      for (const target of SEARCH_TARGETS) {
        const query = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`;
        socket.send(Buffer.from(query), SSDP_PORT, SSDP_ADDRESS);
      }
    });

    setTimeout(() => finish(null), timeoutMs);
  });
}

/** Saca del XML de descripcion el servicio WAN y su controlURL absoluta. */
function findWanService(descriptionXml, location) {
  for (const serviceType of WAN_SERVICE_TYPES) {
    const block = descriptionXml
      .split(/<service>/i)
      .find((chunk) => chunk.includes(serviceType));
    if (!block) continue;
    const controlUrl = /<controlURL>\s*([^<]+)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!controlUrl) continue;
    return { serviceType, controlUrl: new URL(controlUrl.trim(), location).toString() };
  }
  return null;
}

async function soap(controlUrl, serviceType, action, body) {
  const envelope =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`;

  const response = await fetch(controlUrl, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) {
    const errorCode = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text)?.[1];
    throw new Error(`${action} fallo (HTTP ${response.status}${errorCode ? `, UPnP ${errorCode}` : ""})`);
  }
  return text;
}

/**
 * Mapea el puerto contra un IGD ya conocido. Separado de mapPort() para poder
 * probar el camino SOAP completo contra un router de mentira en los tests.
 */
async function mapPortAt(location, { port, internalAddress, description = "We Connect direct host", ttlSeconds = 0 }) {
  const description_xml = await fetch(location, { signal: AbortSignal.timeout(5000) }).then((res) => res.text());
  const service = findWanService(description_xml, location);
  if (!service) return { ok: false, reason: "El router respondio pero no expone el servicio WAN de UPnP." };

  const internalClient = internalAddress ?? (await localAddressTowards());
  if (!internalClient) return { ok: false, reason: "No se pudo determinar la IP local de esta PC." };

  await soap(
    service.controlUrl,
    service.serviceType,
    "AddPortMapping",
    `<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort><NewProtocol>TCP</NewProtocol>` +
      `<NewInternalPort>${port}</NewInternalPort><NewInternalClient>${internalClient}</NewInternalClient>` +
      `<NewEnabled>1</NewEnabled><NewPortMappingDescription>${description}</NewPortMappingDescription>` +
      `<NewLeaseDuration>${ttlSeconds}</NewLeaseDuration>`
  );

  const externalIpXml = await soap(service.controlUrl, service.serviceType, "GetExternalIPAddress", "");
  const externalIp = /<NewExternalIPAddress>\s*([^<]*)\s*<\/NewExternalIPAddress>/i.exec(externalIpXml)?.[1]?.trim();

  return { ok: true, externalIp: externalIp || null, internalClient, service: service.serviceType, location };
}

/** Descubre el router y mapea el puerto. Nunca lanza. */
async function mapPort(options) {
  try {
    const location = await discover(options.discoveryTimeoutMs ?? 3000);
    if (!location) {
      return { ok: false, reason: "El router no respondio a UPnP (suele venir desactivado de fabrica)." };
    }
    return await mapPortAt(location, options);
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

async function unmapPortAt(location, port) {
  try {
    const description_xml = await fetch(location, { signal: AbortSignal.timeout(5000) }).then((res) => res.text());
    const service = findWanService(description_xml, location);
    if (!service) return false;
    await soap(
      service.controlUrl,
      service.serviceType,
      "DeletePortMapping",
      `<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort><NewProtocol>TCP</NewProtocol>`
    );
    return true;
  } catch {
    return false;
  }
}

/** ¿Alguien contesta en host:port desde afuera? Se usa para avisar al anfitrion. */
function isReachable(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

module.exports = { discover, mapPort, mapPortAt, unmapPortAt, localAddressTowards, isReachable, findWanService };
