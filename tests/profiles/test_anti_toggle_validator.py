#!/usr/bin/env python3
"""
Prueba REAL de tools/validate_profiles.py contra la regla anti-TOGGLE nueva
para write.type: clientDataEvent (semantics obligatoria y no trivial).

No se mockea nada: se invoca tools/validate_profiles.py como subproceso real
(el mismo comando que correría qa-agent). validate_profiles.py escanea
aircraft-profiles/*/manifest.yaml con una ruta ROOT hardcodeada (no acepta un
directorio alternativo por CLI), así que este test crea un perfil fixture
TEMPORAL dentro de aircraft-profiles/ (prefijo "tmp-test-anti-toggle-" para
que sea obvio que es basura de test), corre el validador de verdad, y borra
el fixture en un `finally` sin importar el resultado — nunca debe dejar
residuos en aircraft-profiles/ real.

Requiere: pip install pyyaml jsonschema (mismas deps que tools/validate_profiles.py).
Uso: python tests/profiles/test_anti_toggle_validator.py
"""
import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = REPO_ROOT / "tools" / "validate_profiles.py"
AIRCRAFT_PROFILES_DIR = REPO_ROOT / "aircraft-profiles"

MANIFEST_TEMPLATE = """\
schemaVersion: 1
aircraft:
  id: {profile_id}
  name: Anti Toggle Fixture
  developer: tests-agent
compatibility:
  msfs2020: true
  msfs2024: false
versions:
  minimum: "1.0.0"
  tested:
    - "1.0.0"
detection:
  titleContains:
    - "Anti Toggle Fixture"
capabilities:
  flightControls: none
  autopilot: partial
  electrical: none
  hydraulics: none
  radios: none
  mcdu: none
  failures: none
"""

DETECTION_YAML = """\
titleContains:
  - "Anti Toggle Fixture"
fallbackToPartialMatch: true
"""


class AntiToggleValidatorTests(unittest.TestCase):
    """Cada test crea su propio perfil fixture temporal (uuid en el id) para
    no interferir entre tests si corren en paralelo, y lo borra al final."""

    def setUp(self):
        self.profile_id = f"tmp-test-anti-toggle-{uuid.uuid4().hex[:8]}"
        self.profile_dir = AIRCRAFT_PROFILES_DIR / self.profile_id
        (self.profile_dir / "controls").mkdir(parents=True, exist_ok=True)
        (self.profile_dir / "manifest.yaml").write_text(
            MANIFEST_TEMPLATE.format(profile_id=self.profile_id), encoding="utf-8"
        )
        (self.profile_dir / "detection.yaml").write_text(DETECTION_YAML, encoding="utf-8")

    def tearDown(self):
        if self.profile_dir.exists():
            shutil.rmtree(self.profile_dir)

    def write_control(self, control_yaml: str):
        (self.profile_dir / "controls" / "test.yaml").write_text(control_yaml, encoding="utf-8")

    def run_validator(self):
        return subprocess.run(
            [sys.executable, str(VALIDATOR)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_rejects_clientDataEvent_with_semantics_literally_toggle(self):
        self.write_control(f"""\
- id: autopilot.irs_mode_selector
  dataType: number
  authority: shared
  sdkTier: clientDataArea
  read:
    type: clientDataArea
    areaName: PMDG_NG3_Data
    field: IRS_ModeSelector
    nativeType: uchar
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "1234"
    semantics: toggle
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: true
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn("anti-toggle", result.stdout)
        self.assertIn(self.profile_id, result.stdout)
        self.assertIn("TOGGLE crudo disfrazado", result.stdout)

    def test_rejects_clientDataEvent_with_semantics_toggles_plural(self):
        self.write_control(f"""\
- id: autopilot.irs_mode_selector
  dataType: number
  authority: shared
  sdkTier: clientDataArea
  read:
    type: clientDataArea
    areaName: PMDG_NG3_Data
    field: IRS_ModeSelector
    nativeType: uchar
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "1234"
    semantics: Toggles
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: true
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn("TOGGLE crudo disfrazado", result.stdout)

    def test_rejects_clientDataEvent_missing_semantics_via_json_schema(self):
        # Sin 'semantics' del todo: el JSON Schema (control.schema.json) ya lo
        # exige como campo requerido en la forma clientDataEvent, así que esto
        # debe fallar como error de schema (no como el chequeo heurístico de
        # 'semantics vacía' del propio script, que es defensa en profundidad
        # para cuando semantics SÍ está presente pero en blanco).
        self.write_control(f"""\
- id: autopilot.irs_mode_selector
  dataType: number
  authority: shared
  sdkTier: clientDataArea
  read:
    type: clientDataArea
    areaName: PMDG_NG3_Data
    field: IRS_ModeSelector
    nativeType: uchar
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "1234"
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: true
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[control:{self.profile_id}", result.stdout)

    def test_rejects_clientDataEvent_with_toggle_in_event_name_for_boolean_control(self):
        self.write_control(f"""\
- id: lights.beacon
  dataType: boolean
  authority: shared
  sdkTier: clientDataArea
  read:
    type: clientDataArea
    areaName: PMDG_NG3_Data
    field: BeaconLight
    nativeType: bool
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "BEACON_LIGHT_TOGGLE"
    semantics: sets beacon light state
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: true
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn("anti-toggle", result.stdout)

    def test_accepts_clientDataEvent_with_valid_descriptive_semantics(self):
        self.write_control(f"""\
- id: autopilot.irs_mode_selector
  dataType: number
  authority: shared
  sdkTier: clientDataArea
  read:
    type: clientDataArea
    areaName: PMDG_NG3_Data
    field: IRS_ModeSelector
    nativeType: uchar
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "1234"
    parameter: "0"
    semantics: sets IRS mode selector to NAV
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: true
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"Validado: {self.profile_id}", result.stdout)
        # Nota: no se puede usar assertNotIn("anti-toggle", ...) a secas aquí:
        # el propio profile_id de este test contiene la subcadena "anti-toggle"
        # (es literalmente su nombre), así que aparece en la línea normal
        # "Validado: tmp-test-anti-toggle-xxxx" aunque no haya ningún error.
        # Se verifica en cambio que no aparezca el prefijo de log de violación
        # real ("[anti-toggle:") ni el mensaje de fallo final.
        self.assertNotIn("[anti-toggle:", result.stdout)
        self.assertNotIn("FALLÓ la validación de perfiles", result.stdout)

    def test_still_rejects_legacy_raw_toggle_inputEvent_for_boolean(self):
        # No relacionado a clientDataEvent — confirma que la regla anti-TOGGLE
        # preexistente (write.name con 'TOGGLE' para inputEvent) sigue viva
        # después de extender el schema/validador para las formas nuevas.
        self.write_control(f"""\
- id: lights.beacon
  dataType: boolean
  authority: shared
  read:
    type: simvar
    name: "LIGHT BEACON"
  write:
    type: inputEvent
    name: "BEACON_LIGHTS_TOGGLE"
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: true
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn("anti-toggle", result.stdout)


if __name__ == "__main__":
    unittest.main()
