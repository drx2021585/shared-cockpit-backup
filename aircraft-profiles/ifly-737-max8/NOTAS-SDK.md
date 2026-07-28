# iFly 737 MAX 8 — cómo se llega a la cabina, y qué falta

Notas de la sesión 2026-07-28, escritas al portar el avión. Todo lo que sigue
sale de inspeccionar la instalación real de Darwin en
`apps/desktop-ui/recurso/ifly-aircraft-737max8/` (paquete v1.1.0.0), no de
documentación de terceros.

## 1. La cabina es 100 % L-Vars

En `SimObjects/Airplanes/iFly 737-MAX8/model/iFly737Max_INTERIOR.xml` (1.3 MB,
1797 L-Vars distintas) **no hay un solo evento `H:`, `K:` ni `B:`**. Hay dos
familias de L-Var:

| Familia | Rol | Ejemplo |
|---|---|---|
| `L:VC_<control>_VAL` | **estado**, lo escribe el WASM de iFly y lo consume el `<ANIM_CODE>` de la animación | `L:VC_Fuel_Crossfeed_SW_VAL` |
| `L:VC_<sistema>_trigger_VAL` | **entrada**, un clic escribe aquí un código entero de comando | `L:VC_Fuel_trigger_VAL` |

Hay exactamente **16** L-Vars de trigger, una por sistema: `Air_Systems`,
`Anti_Ice`, `Automatic_Flight`, `Communications`, `EFB`, `Electrical`,
`Engine_APU`, `Fire_Protection`, `Flight_Control`, `Fuel`, `Gear`,
`Hydraulics`, `Instruments`, `Miscellaneous`, `Navigation`, `Warning_Systems`.

Ejemplo real, el selector CROSSFEED:

```
(M:Event) 'LeftSingle' scmp 0 == if{ 1 (>L:VC_Fuel_trigger_VAL,number) }
```

## 2. Cómo se derivó cada control del perfil

`controls/*.yaml` se generó mecánicamente recorriendo los 1054 `<Component>`
con `<CallbackCode>` del XML. Convención encontrada (consistente en todo el
modelo):

- **`WheelUp` / `WheelDown`** son el par direccional canónico cuando existen y
  son distintos. En 208 de los 227 controles "limpios" además se cumple
  `LeftSingle == WheelDown` y `RightSingle == WheelUp`.
- **`LeftRelease`** es el código de soltar un botón momentáneo (`LeftSingle` es
  el de pulsar).
- Códigos de rueda en **0** significan "la rueda no hace nada en este control".

De ahí salen tres formas de escritura, todas en RPN vía
`write.type: calculatorCode`:

| Forma | Cuántos | RPN |
|---|---|---|
| Selector posicional (par direccional + L-Var de estado) | 340 | `(L:X_VAL,number) $value < if{ SUBE (>L:trigger) } (L:X_VAL,number) $value > if{ BAJA (>L:trigger) }` |
| Botón momentáneo (pulsar/soltar) | 568 | `$value 0 > if{ PULSA (>L:trigger) } els{ SUELTA (>L:trigger) }` |
| Código único (iFly cicla la posición) | 133 | `(L:X_VAL,number) $value != if{ CODIGO (>L:trigger) }` |
| Sin L-Var de estado → `writeOnly: true` | 71 | misma forma, sin `read` |

Ninguna de las tres es un TOGGLE ciego: las tres comparan el estado real contra
el valor pedido antes de disparar. Eso es lo que permite cumplir la regla
anti-TOGGLE del proyecto pese a que **iFly no expone ningún SET absoluto**.

## 3. Transporte: FSUIPC7, sin componente nuevo dentro del sim

- **Lectura**: `FsuipcLVarClient` (`FSUIPCConnection.ReadLVar`), área
  `SharedCockpitBridge_LVars`, donde `field` es el nombre crudo de la L-Var.
  Mismo camino ya confirmado en vivo con el PMDG 737-900.
- **Escritura**: `MSFSVariableServices.ExecuteCalculatorCode` (módulo WAPI de
  FSUIPC7), también ya confirmado en vivo con el PMDG.

No hace falta instalar `simulator/wasm-bridge` ni ningún módulo propio para
este avión.

## 4. Limitaciones honestas (leer antes de confiar en el perfil)

1. **Nada probado en vivo.** El perfil entero es derivación estática del XML.
   Es evidencia fuerte sobre *qué código dispara cada control*, no prueba del
   efecto real en el sim.
2. **Una escritura = un paso, y hoy nadie reintenta.** Un selector de varias
   posiciones necesita varias escrituras para converger, pero el bridge escribe
   una sola vez por cambio recibido del otro piloto. Ojo con el
   `confirmAfterWrite: true` que declaran estos controles: hoy **no hace nada**
   — `ProfileRepository` lo deserializa y `BridgeService` nunca lo lee (grep
   `ConfirmAfterWrite` en `apps/simulator-bridge/src/`: solo aparece en el DTO,
   el modelo y el mapeo). `packages/synchronization-core/src/drift.ts` tiene la
   detección de divergencia, pero ni `apps/desktop-ui` ni `server/api` la
   importan todavía. Así que para este avión el lazo de convergencia
   (escribir → releer → repetir hasta igualar) es trabajo pendiente REAL del
   `sync-engine-agent`, no algo que ya esté cubierto.
3. **Polaridad asumida.** Se asume que el código de `WheelUp` aumenta el
   `_VAL`. Si en algún control resultara al revés, la escritura da **un** paso
   en sentido contrario (no un bucle). Como no hay confirmación automática (ver
   punto 2), esto se detecta mirando la cabina, no por telemetría: validar
   sistema por sistema en la prueba en vivo.
4. **Volumen de lectura.** 982 controles con `read` → 982 `ReadLVar` por
   ciclo de `Pump()` (33 ms por defecto). Si en la prueba en vivo eso satura
   FSUIPC, la mitigación obvia es subir `pumpInterval` o recortar
   `controls/efb.yaml` y `controls/misc.yaml`, que son los dos archivos menos
   necesarios para un vuelo compartido (tablets personales y mobiliario).

## 5. El SDK propio de iFly (todavía sin usar)

Dentro de `panel/iFly737-MAX.wasm` (21 MB) aparecen, confirmados por strings:

- Client Data Area **`737MAX_SDK_ClientData`**
- Evento cliente con nombre **`737MAX_External_Command`** (precedido del
  marcador `Client.Event`, o sea registrado con `MapClientEventToSimEvent`)
- Símbolos `InitSdkLvar()`, `ProcessSdkLvar()`, `Write2SDK()`,
  `_GLOBAL__sub_I_SDK_737MAX.cpp`, `ShareMemory737MAXSDK_*`

Ambos canales son alcanzables desde SimConnect externo puro — **sin módulo
WASM propio**, a diferencia del camino del PMDG. Lo que falta es el header
oficial de iFly con:

- el layout del struct de `737MAX_SDK_ClientData` (para lectura en bloque en
  vez de 982 `ReadLVar` sueltos), y
- la codificación del parámetro de `737MAX_External_Command` (que podría dar
  SETs absolutos de verdad y eliminar la limitación del punto 4.2).

Conseguir ese header es la mejora de mayor impacto pendiente para este avión.

## 6. Checklist de validación en vivo (pendiente)

Por sistema, con MSFS + iFly cargado y FSUIPC7 corriendo:

- [ ] El bridge reporta `Perfil detectado: 'ifly-737-max8'` al cargar el avión.
      (La detección ya está verificada estáticamente contra los 7 títulos
      reales de los 4 paquetes — ver `detection.yaml` y los tests
      `Ifly737Max8_MatchesEveryRealAircraftTitle_*`. Lo que falta confirmar en
      vivo es solo que MSFS reporte la simvar `TITLE` con ese mismo texto.)
- [ ] Mover un switch en cabina emite el `control.event` correcto (probar uno
      simple: `fuel.fuel_crossfeed_sw`).
- [ ] Escribir ese mismo control desde el otro asiento mueve el switch real.
- [ ] Confirmar polaridad en un selector de 3+ posiciones
      (`gear.autobrake_sw` es buen candidato: OFF/1/2/3/MAX).
- [ ] Confirmar un botón momentáneo (`navigation.*` del teclado del CDU).
- [ ] Medir si 982 `ReadLVar` por ciclo es sostenible; ajustar si no.
