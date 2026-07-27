# SharedCockpitBridge (`simulator/wasm-bridge`)

Módulo WASM standalone que corre DENTRO de MSFS (no un proceso externo), cuyo
único trabajo es exponer L-Vars que un cliente SimConnect externo (como
`apps/simulator-bridge`) no puede leer por sí solo. Nace de una decisión de
arquitectura real (ver memoria del proyecto
`decision_wasm_bridge_pmdg_sync`): el SDK oficial de PMDG (`PMDG_NG3_SDK.h`,
Client Data Area) nunca produjo efecto real en pruebas en vivo contra MSFS,
mientras que el mecanismo usado por YourControls (L-Vars + un evento nativo
de SimConnect reutilizado como bus) sí funciona — pero leer un L-Var desde
fuera del simulador requiere un módulo WASM corriendo adentro. Este es ese
módulo.

## Qué hace hoy (v0.1, 2026-07-27)

- Registra las 181 L-Vars del PMDG 737NG usadas por
  `aircraft-profiles/pmdg-737-900/controls/native-toggle-switches.yaml`
  (mismos 181 switches cuya ESCRITURA ya está confirmada real contra MSFS,
  vía el evento nativo `ROTOR_BRAKE`).
- Cada fotograma (`SubscribeToSystemEvent(..., "Frame")`), relee esas 181
  L-Vars y, si algo cambió, transmite el array completo de `double` (1448
  bytes) a un Client Data Area propio llamado `SharedCockpitBridge_LVars`
  (creado por este módulo vía `SimConnect_CreateClientData` — a diferencia
  de `PMDG_NG3_Data`, que PMDG crea y nosotros solo mapeamos, aquí el dueño
  del área somos nosotros).
- **Todavía NO expone esto a `apps/simulator-bridge`** — ese es el trabajo
  pendiente del lado C# (un cliente nuevo, mirror de
  `SimConnectInterop/PmdgClientDataClient.cs`, apuntado a
  `SharedCockpitBridge_LVars` en vez de `PMDG_NG3_Data`), y actualizar
  `aircraft-profiles/pmdg-737-900/controls/native-toggle-switches.yaml` para
  agregar un bloque `read` a cada uno de los 181 controles (hoy son
  `writeOnly: true` porque no había forma de leerlos).

## Compilación (confirmado real, 2026-07-27 — sin Visual Studio instalado)

No hay Visual Studio en esta máquina, así que se compiló invocando el
compilador/enlazador del SDK directamente (`clang-cl.exe`/`wasm-ld.exe` bajo
`C:\MSFS 2024 SDK\WASM\llvm\bin\`), reconstruyendo a mano los flags que usa
`Samples/DevmodeProjects/Misc/StandaloneModule/Sources/Code/StandaloneModule.vcxproj`
del SDK (el toolset registrado `MSFS2024` de Visual Studio hace esto mismo
automáticamente si VS está instalado — este camino manual es el fallback).

**IMPORTANTE (gotcha de Git Bash/MSYS2):** los flags estilo `/EHs-c-`, `/GR-`
se interpretan como rutas de archivo por la conversión automática de rutas de
MSYS2 — hay que anteponer `MSYS2_ARG_CONV_EXCL="*"` al comando o usarlo desde
PowerShell/cmd.exe en vez de Git Bash.

```bash
# 1. Compilar (clang-cl, target wasm32-wasi)
cd simulator/wasm-bridge
MSYS2_ARG_CONV_EXCL="*" "/c/MSFS 2024 SDK/WASM/llvm/bin/clang-cl.exe" \
  --target=wasm32-wasi \
  "/clang:--sysroot=C:\MSFS 2024 SDK\WASM\wasi-sysroot" \
  /clang:-fms-extensions /clang:-fdeclspec \
  "-IC:\MSFS 2024 SDK\WASM\include" \
  "-IC:\MSFS 2024 SDK\SimConnect SDK\include" \
  -D_MSFS_WASM -D_STRING_H_CPLUSPLUS_98_CONFORMANCE_ -D_WCHAR_H_CPLUSPLUS_98_CONFORMANCE_ \
  -D_LIBCPP_NO_EXCEPTIONS -D_LIBCPP_HAS_NO_THREADS \
  /EHs-c- /GR- \
  /c Sources/Code/Module.cpp /Fo"build/Module.obj"

# 2. Enlazar (wasm-ld directo -- el driver de clang-cl no encontraba
#    libclang_rt.builtins-wasm32.a en la ruta que esperaba por defecto)
SYSROOT="/c/MSFS 2024 SDK/WASM/wasi-sysroot"
"/c/MSFS 2024 SDK/WASM/llvm/bin/wasm-ld.exe" \
  --no-entry \
  --export=module_init --export=module_deinit \
  --allow-undefined \
  -L"$SYSROOT/lib/wasm32-wasi" \
  "$SYSROOT/lib/wasm32-wasi/crt1-reactor.o" \
  build/Module.obj \
  -lc -lc++ -lc++abi -lclang_rt.builtins-wasm32 \
  -o build/SharedCockpitBridge.wasm

# 3. Copiar al paquete
cp build/SharedCockpitBridge.wasm PackageSources/modules/SharedCockpitBridge.wasm
```

Confirmado: compila y enlaza sin errores (solo warnings de deprecación —
`register_named_variable`/`get_named_variable_value` están marcadas
deprecated a favor de `MSFS_Vars.h`, pendiente de migrar). Binario WASM
válido confirmado (`\0asm` magic bytes), exporta `module_init`/`module_deinit`
correctamente (verificado con `grep -a` sobre el binario).

**Lo que NO se pudo confirmar en esta sesión** (requiere instalarlo en MSFS
real y reconfirmar contra el vuelo cargado, igual que se hizo con el bridge
C# esta misma noche): que el módulo realmente cargue al iniciar el sim, que
`SimConnect_CreateClientData` efectivamente cree el área sin colisión, y que
los valores de L-Var leídos coincidan con el estado real de cada switch.

## Cómo instalarlo para probar (Community package)

1. Copiar toda la carpeta `PackageSources/` a
   `%APPDATA%\Microsoft Flight Simulator\Packages\shared-cockpit-bridge\`
   (o el Community folder equivalente de tu instalación — mismo patrón que
   ya tienes con YourControls en
   `apps/desktop-ui/recurso/community/YourControls/`).
2. Reiniciar MSFS (los módulos `content_type: MISC` cargan al iniciar el
   sim, no por avión — no requiere `panel.cfg` ni asociarlo a ninguna
   aeronave, mismo patrón que YourControls).
3. Si carga bien, no debería haber ningún error visible; para confirmarlo de
   verdad hace falta el cliente C# nuevo (pendiente) leyendo
   `SharedCockpitBridge_LVars` y comparando contra el estado real del switch
   en cabina.

## Diseño (por qué esta forma, no otra)

- **Reactor, no command** (`crt1-reactor.o`, no `crt1-command.o`): el módulo
  no tiene un `main()` que corra una vez y termine — expone funciones
  (`module_init`/`module_deinit`) que el host WASM de MSFS llama en
  momentos específicos, patrón de "librería", no de "programa".
- **`content_type: MISC`, sin panel.cfg**: confirmado con el sample oficial
  del SDK (`StandaloneModule`) y con la instalación real de YourControls que
  ambos cargan así — un módulo de fondo no necesita estar atado a un avión.
- **Un solo Client Data Area con 181 `double`**: mismo patrón que
  `PMDG_NG3_Data` (un struct fijo grande) en vez de un protocolo de consulta
  dinámica — más simple de implementar primero, aunque menos flexible que
  pedir L-Vars arbitrarias en tiempo de ejecución (mejora futura posible).
- **Broadcast solo si cambió algo** (no cada frame incondicionalmente):
  mismo principio de "SET/Changed, no polling ciego" que ya usa el resto del
  bridge.
