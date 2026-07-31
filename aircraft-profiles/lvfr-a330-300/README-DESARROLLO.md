# LVFR A330-300 - Guía de Desarrollo

## Estado Actual
- **Disponibilidad**: Soon (próximamente)
- **Cobertura**: ~15% (scaffold básico)
- **Verificación**: Untested (no validado en vivo)

## Estructura Creada
```
lvfr-a330-300/
├── manifest.yaml                    ✅ Creado (básico)
├── capabilities.yaml                ✅ Creado (con TODOs)
├── detection.yaml                   ✅ Mejorado
├── controls/
│   ├── autoflight.yaml             ✅ Scaffold (3 controles básicos)
│   ├── electrical.yaml             ✅ Scaffold (solo BAT selector)
│   ├── fuel.yaml                   ✅ Scaffold (cantidades nada más)
│   ├── instruments.yaml            ✅ Scaffold (solo ND range)
│   ├── engines.yaml                ✅ Scaffold (throttles + TODO)
│   ├── flight-controls.yaml        ✅ Scaffold (controles básicos)
│   ├── radios.yaml                 ⏳ PENDIENTE
│   ├── mcdu.yaml                   ⏳ PENDIENTE
│   ├── hydraulics.yaml             ⏳ PENDIENTE
│   ├── anti-ice.yaml               ⏳ PENDIENTE
└── README-DESARROLLO.md            (este archivo)
```

## Próximos Pasos - Prioridad

### FASE 1: Auditoría del XML (CRÍTICA)
1. Localizar carpeta real del A330-300 en LVFR:
   ```
   apps/desktop-ui/recurso/Aeronaves/lvfr-a330-300/
   ```
2. Extraer todos los archivos `.xml` principales:
   - `cockpit.xml` (layout de cabina)
   - `engines.xml` (motor y APU)
   - `systems.xml` (electrical, hydraulics, etc.)
   - `flight_model.xml` (controles de vuelo)
   - Buscar cualquier archivo de `aircraft.cfg`

3. Mapear **LVar names** exactos (búsqueda en XMLs por `L:` y `(L:`)
4. Mapear **eventos H:** exactos (búsqueda por `(>H:`)
5. Mapear **índices de arrays** si existen

### FASE 2: Completar Scaffolds (2-3 horas)
Copiar patrones del A330-200 y reemplazar:
- [ ] `radios.yaml` - Copiar de A330-200, cambiar H: eventos si necesario
- [ ] `mcdu.yaml` - Copiar teclado MCDU de A330-200
- [ ] `hydraulics.yaml` - Copiar sistemas HYD verde/azul/amarillo
- [ ] `anti-ice.yaml` - Copiar anti-ice completo
- [ ] Expandir `autoflight.yaml` - Agregar modos managed + validación
- [ ] Expandir `electrical.yaml` - Agregar gen switches, APU, bus transfers
- [ ] Expandir `fuel.yaml` - Agregar transfers, pumps
- [ ] Expandir `flight-controls.yaml` - Agregar trim completo, gear

### FASE 3: Validación en Vivo (REQUISITO)
**NO COMPLETAR NINGÚN CONTROL SIN PRUEBA EN VIVO**

1. Abrir MSFS 2024 + cargar A330-300 LVFR
2. Probar cada control:
   - ¿Se sincroniza entre dos jugadores?
   - ¿Refleja el estado real del avión?
   - ¿Los eventos H: activan la función correcta?
3. Crear `EVENT_IDS_PENDIENTES.md` con:
   - Controles confirmados ✅
   - Controles candidatos pendientes ⏳
   - Controles fallidos ❌

### FASE 4: Marcar como Completo
Una vez validado en vivo:
```yaml
# En manifest.yaml
availability: released
verification: live-tested

# En capabilities.yaml
# Cambiar todos los niveles de "partial" → "full"
```

## Convención de Nombres
Seguir patrones del A330-200:
- **LVar fields**: `XMLVAR_*` (estandarizado para LVFR)
- **Eventos H:**: `LVFR_Airbus_*` (patrón específico de LVFR)
- **Control IDs**: `kebab-case` (ej: `anti_ice_left`, no `AntiIceLeft`)

## Referencia Rápida
| Archivo | Controles | Estado | Prioridad |
|---------|-----------|--------|-----------|
| autoflight.yaml | 3/12 | Scaffold | ALTA |
| electrical.yaml | 1/7 | Scaffold | ALTA |
| engines.yaml | 2/15 | Scaffold | ALTA |
| fuel.yaml | 3/9 | Scaffold | MEDIA |
| flight-controls.yaml | 4/20 | Scaffold | MEDIA |
| instruments.yaml | 1/8 | Scaffold | MEDIA |
| radios.yaml | 0/15 | VACÍO | MEDIA |
| mcdu.yaml | 0/28 | VACÍO | BAJA |
| hydraulics.yaml | 0/15 | VACÍO | BAJA |
| anti-ice.yaml | 0/10 | VACÍO | BAJA |

## Notas Técnicas
1. **Diferencias A330-200 vs A330-300**:
   - A330-300 es más largo pero cabina similar
   - Motores: Mismo modelo (GE/PW/RR) pero quizá diferentes ratings
   - Sistemas: Debería ser 95% idéntico al 200
   - **Asumir**: Cambiar solo LVar names específicos si no son idénticos

2. **SdkTier clientDataArea**:
   - Usar para LVars que no están en SimConnect estándar
   - Área: `SharedCockpitBridge_LVars` (establecida para LVFR)
   - Escribir con `calculatorCode` y eventos `H:`

3. **Validación**: Usar `confirmAfterWrite: true` en todos los controles escribibles

## Recursos
- A330-200 profile completo: `lvfr-a330-200/` (referencia)
- PMDG 737-900 profile: `pmdg-737-900/` (patrón avanzado con SDK)
- Guía general: `packages/profile-schema/README.md`
