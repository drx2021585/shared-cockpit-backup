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

## 4. Estado real tras la primera sesión en vivo (2026-07-29)

Esta sección se reescribió entera después de probar contra MSFS 2020 y contra
una sesión real de dos jugadores. Lo que decía antes ("nada probado en vivo",
"confirmAfterWrite no hace nada", "el volumen de lectura puede saturar FSUIPC")
era correcto cuando se escribió y hoy ya no lo es.

### Confirmado funcionando

- **Detección**, incluido el MAX 8-200 (`partialMatch=False`).
- **Lectura**: las 982 L-Vars se suscriben y se leen con **cero errores**. El
  miedo a que 982 `ReadLVar` cada 33 ms saturaran FSUIPC no se materializó: no
  hace falta recortar `efb.yaml` ni `misc.yaml`.
- **Escritura de interruptores**: APU (OFF↔ON), selector multiposición
  (`gear.autobrake_sw`, caminó 50→0 en 5 pasos).
- **Ejes**: elevador y alerón se mueven con la escala y el signo correctos.
- **Lazo de convergencia**: existe y funciona. `confirmAfterWrite` está
  implementado y reintenta hasta que el control llega.

### Lo que sigue abierto

1. **La POLARIDAD varía por CONTROL, no por sistema.** Este es el hallazgo que
   más cambia el panorama. `gear.autobrake_sw` respeta la convención de la rueda
   del modelo (WheelUp = subir); `engine.apu_sw` la tiene INVERTIDA, medido en
   vivo. Los dos salieron del mismo generador con la misma regla, así que la
   regla acierta en unos y falla en otros, y **no hay forma de saber cuáles
   desde el XML**. El consejo anterior de "validar por sistema" era equivocado.

   **RESUELTO (2026-07-29) — el bridge la aprende solo.** No hace falta saber la
   polaridad de antemano ni medir los 339 controles a mano: el lazo de
   convergencia ya detecta los dos síntomas de una polaridad cruzada, y ahora
   los CORRIGE en vez de rendirse. Ver `Bridge/PolarityCalibration.cs`.

   - Síntoma A, el control queda MÁS LEJOS del destino que cuando empezó → se
     invierte su RPN y se reintenta con ventana limpia. Contra la distancia de
     PARTIDA, no contra la lectura anterior: estas L-Vars se animan (14.75 leído
     en tránsito entre 20 y 10), así que un control correcto puede sobrepasar el
     destino y alejarse respecto de la lectura previa sin que nada esté mal.
     Juzgarlo contra la anterior invertía —y persistía— controles que estaban
     bien. La distancia de partida se toma de la lectura que ya había antes de
     escribir, así que la divergencia real se detecta en la primera lectura
     posterior.
   - Síntoma B, el control NO se mueve en absoluto (está contra el tope y la
     escritura empuja hacia afuera) → mismo tratamiento. Este era el punto ciego
     de la 0.1.13, que solo sabía nombrarlo: el detector de divergencia necesita
     ver crecer la distancia, y un control que no se mueve no emite lecturas.

   La inversión es sintáctica: intercambia los operadores `<` y `>` pegados a
   `$value`, sin tocar los códigos de comando. Por construcción alcanza SOLO a la
   forma posicional de dos ramas que emite el generador — las otras tres formas y
   los controles calibrados a mano (`engine.apu_sw`, que compara por bandas)
   quedan excluidos sin necesidad de una lista de excepciones.

   Coste de un control mal calibrado: un paso perdido, UNA vez. Después queda
   correcto, y la corrección se persiste en
   `%APPDATA%\we-connect-desktop-ui\polarity-calibration.json`, así que se
   acumula entre sesiones.

   Reversión: si tras invertir el control sigue alejándose, la polaridad no era
   la causa y la inversión se deshace. Sin eso, un fallo ajeno (sistema sin
   alimentación, L-Var inexistente en la variante) dejaría una inversión errónea
   persistida, rompiendo un control que estaba bien declarado. La reversión se
   dispara SOLO por divergencia, nunca por "no se movió": ese síntoma es ambiguo
   y revertir con él perdería calibraciones correctas.

   Lo que queda: volcar lo aprendido a los `controls/*.yaml` para que llegue a
   todos los jugadores en la release siguiente, en vez de que cada instalación lo
   re-aprenda por su cuenta.

1. **`confirmAfterWrite` repetía los botones momentáneos.** Encontrado
   2026-07-29 leyendo el perfil, no en vuelo. **RESUELTO.**

   El generador emitía `confirmAfterWrite: true` para todo control con L-Var de
   estado, incluidos los momentáneos. Pero un pulso no tiene estado estable que
   confirmar: se pulsa y vuelve solo, la lectura nunca sostiene el valor pedido,
   y el lazo reintentaba durante toda la ventana — **volviendo a pulsar la tecla
   en cada intento**, ~9 veces en 6 s. Una pulsación del otro piloto podía
   escribir el mismo carácter nueve veces en el CDU.

   Radio real medido sobre el perfil: **580 controles** con forma de pulso, los
   580 con `confirmAfterWrite: true`. Más que los 339 posicionales.

   Segundo fallo en la misma clase: `AlreadyAtValue` (el filtro anti-avalancha de
   la 0.1.12) descartaba el pulso de SOLTAR, porque llega con valor `false` justo
   cuando la L-Var ya lee 0 — y el botón quedaba lógicamente hundido dentro del
   iFly. El comentario de ese filtro daba por hecho que los momentáneos eran
   todos `writeOnly` y por eso quedaban fuera; en el iFly solo 71 lo son.

   La regla correcta NO es sacar los pulsos del filtro (eso los escribiría
   siempre, y los 580 llegan todos en el estado inicial al conectar: ~6 minutos de
   canal tapado, la misma avalancha por otra puerta). Es tratarlos **por pares**:
   el "pulsar" siempre se ejecuta, y el "soltar" solo si nosotros pulsamos antes.
   Así el pulso nunca queda a medias y el estado inicial no dispara nada, porque
   en reposo todos los botones llegan sueltos.

   Tercer y cuarto fallo, en la dirección SALIENTE (auditoría 2026-07-29):

   - **El debouncer se tragaba pulsaciones.** El perfil declara `debounceMs: 50`
     para los 560 pulsos con `read`, y el debouncer colapsa cambios dentro de la
     ventana. Un doble toque rápido en el CDU (pulsar 0 ms, soltar 40 ms, pulsar
     45 ms) perdía la segunda pulsación, y el "soltar" salía siempre con retraso.
     El debouncing existe para interruptores ruidosos; en un momentáneo las dos
     transiciones son significativas y caen por definición dentro de la misma
     ventana. Ahora los pulsos no se debouncean.

   - **Lazo de eco.** Al escribir un pulso por orden del otro piloto, nuestra
     L-Var cambia, y esa lectura se reemitía como cambio local. El otro lado la
     recibía y —al no pasar los pulsos por `AlreadyAtValue`— la reescribía,
     pulsando su botón otra vez y realimentando el ciclo. Para los posicionales
     el eco es inofensivo porque `AlreadyAtValue` lo descarta en el otro extremo:
     ese filtro hacía DOBLE función (matar la avalancha y suprimir el eco), y al
     sacar los pulsos de él se les quitó también la segunda. Ahora la lectura que
     corresponde a una escritura hecha por orden remota se suprime explícitamente,
     y se consume una sola vez para no silenciar el cambio siguiente, que sí es
     local.

   Verificado sobre el perfil real: 580 pulsos, ninguno de ellos alcanzable por el
   invertidor de polaridad, ninguno con `dataType: number`, y los 51 con forma de
   pulso sin rama `els{` son todos `writeOnly` (quedan fuera por otra vía).

   Arreglado en `Bridge/MomentaryPulse.cs`, reconociendo la forma del RPN
   (`$value 0 > if{...} els{...}`) para no tocar `packages/profile-schema`, que es
   contrato compartido. El generador ya emite `confirmAfterWrite: false`, pero el
   arreglo del bridge cubre los perfiles ya generados sin regenerarlos — que es
   lo que hay que hacer, porque regenerar borraría los controles corregidos a
   mano.

2. **Escala de los ejes.** Ver la cabecera de `controls/axes.yaml`: en una tanda
   llegaron al valor exacto y en otra, con el mismo binario, exactamente a la
   mitad. Sin resolver a propósito.

3. **El rudder no se pudo medir** por un eje de hardware que lo pisa 60 veces por
   segundo. No es un problema del perfil.

### La trampa que rompió la primera sesión de dos jugadores

Vale la pena dejarlo escrito porque no es obvio y volvería a pasar con cualquier
aeronave grande:

Al conectar, el bridge del otro piloto emite el estado inicial de sus ~982
controles y la UI los reenvía TODOS como escrituras. Como los dos aviones
arrancan en el mismo estado, la enorme mayoría pedía el valor que el control YA
tenía. Se escribían igual, y cada una quedaba esperando una confirmación
imposible: el bridge solo emite lecturas cuando algo CAMBIA, así que un control
que ya estaba en su sitio nunca reportaba nada. Cada escritura reintentaba 9-10
veces durante 6 s, y el canal de FSUIPC es serializado. El síntoma para el
usuario fue "solo algunos botones funcionan"; en el log, **111 "no convergió" en
un solo segundo**.

Arreglado en la 0.1.12: `BridgeService.AlreadyAtValue` descarta la escritura si
el control ya está en el valor pedido. Los `writeOnly` (botones momentáneos) se
escriben siempre, porque un pulso no tiene estado que comparar.

Queda un riesgo relacionado: si los dos aviones arrancan en estados MUY
distintos (uno en frío, otro listo para taxi), las escrituras ya no son
redundantes y sí hay que ejecutarlas todas. Ahí conviene que ambos jugadores
carguen el avión en el mismo estado antes de conectar.

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
