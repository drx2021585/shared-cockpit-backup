# @shared-cockpit/profile-schema

Esquema formal de los perfiles de aeronave en `aircraft-profiles/*/`.
Dueño: aircraft-profiles-agent (cambios requieren aprobación del orquestador,
porque los consumen wasm-agent y simconnect-bridge-agent).

## Estructura de un perfil

```
aircraft-profiles/<id>/
├── manifest.yaml       # metadata, compatibilidad, versiones probadas
├── detection.yaml       # cómo detectar esta aeronave por título
├── capabilities.yaml    # qué sistemas cubre este perfil y con qué nivel
├── controls/
│   ├── flight-controls.yaml
│   ├── electrical.yaml
│   ├── overhead.yaml
│   ├── autopilot.yaml
│   ├── radios.yaml
│   └── mcdu.yaml
├── mappings/
│   ├── msfs2020.yaml
│   └── msfs2024.yaml
├── scripts/
└── tests/
```

## Regla de oro: read/write separados

Un control declara `read` y `write` por separado porque algunas variables se leen
pero no se escriben igual (o no se pueden escribir directo). Ejemplo:

```yaml
read:
  type: lvar
  name: "L:EXAMPLE_BEACON_STATE"
write:
  type: inputEvent
  name: "EXAMPLE_BEACON_SET"
```

## Regla de oro: nunca TOGGLE

`write.type` nunca debe ser un evento de tipo TOGGLE puro para interruptores
sincronizables — usar SET_ON/SET_OFF/SET_VALUE y confirmar el estado real después
(`synchronization.confirmAfterWrite: true`).

Ver `profile.schema.json` para la validación formal.
