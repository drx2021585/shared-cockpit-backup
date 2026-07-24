# Instrucciones para Claude Code en este repo

Este es el repo de **Shared Cockpit**. Antes de tocar código:

1. Lee `docs/plan-maestro.md` para saber en qué fase/sprint está el proyecto.
2. Si tu tarea cae dentro de la carpeta de un subagente (ver tabla en README.md),
   invoca ese subagente en vez de editar directamente tú mismo.
3. Nunca modifiques `packages/protocol/` o `packages/profile-schema/` sin pasar por
   el `orchestrator` — son contratos compartidos por múltiples agentes.
4. Antes de agregar un control sincronizable a un perfil de aeronave, corre
   `python3 tools/validate_profiles.py` para confirmar que pasa el esquema y la
   regla anti-TOGGLE.
5. Reglas técnicas no negociables (repetidas aquí porque son fáciles de romper por
   accidente):
   - Interruptores: SET_ON/SET_OFF/SET_VALUE explícito, nunca TOGGLE crudo.
   - Todo mensaje recibido de red se marca `origin: remote` y nunca se reenvía como
     si fuera un cambio local.
   - Canal confiable (interruptores, snapshots, roles) vs canal rápido (ejes
     continuos) — ver `packages/protocol/README.md`.
