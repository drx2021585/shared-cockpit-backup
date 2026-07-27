#!/usr/bin/env python3
"""
Prueba REAL de tools/validate_profiles.py contra la marca 'writeOnly: true'
nueva en packages/profile-schema/control.schema.json (simétrica a
'readOnly'), usada por controles sin estado persistente que leer (ej.
botones momentáneos del CDU/MCDU del PMDG NG3 SDK, EVT_CDU_L_EXEC y
similares).

Casos cubiertos:
  1. ACEPTA un control 'writeOnly: true' sin bloque 'read' (forma válida
     para un botón momentáneo con 'write' presente).
  2. RECHAZA un control que declara 'writeOnly: true' Y 'read' a la vez
     (contradicción: un control legible no es de solo escritura).
  3. RECHAZA un control sin 'read' y sin 'writeOnly' (ni 'readOnly'
     tampoco) -- control incompleto, ni de solo lectura ni de solo
     escritura ni con 'read' normal declarado.

No se mockea nada: se invoca tools/validate_profiles.py como subproceso
real, igual que el resto de tests/profiles/. validate_profiles.py escanea
aircraft-profiles/*/manifest.yaml con una ruta ROOT hardcodeada (no acepta
un directorio alternativo por CLI), así que este test crea un perfil
fixture TEMPORAL dentro de aircraft-profiles/ (prefijo "tmp-test-writeonly-"
para que sea obvio que es basura de test) y lo borra en tearDown sin
importar el resultado -- nunca debe dejar residuos en aircraft-profiles/
real.

Requiere: pip install pyyaml jsonschema (mismas deps que
tools/validate_profiles.py).
Uso: python tests/profiles/test_writeonly_validator.py
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
  name: WriteOnly Fixture
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
    - "WriteOnly Fixture"
capabilities:
  flightControls: none
  autopilot: none
  electrical: none
  hydraulics: none
  radios: none
  mcdu: partial
  failures: none
"""

DETECTION_YAML = """\
titleContains:
  - "WriteOnly Fixture"
fallbackToPartialMatch: true
"""


class WriteOnlyValidatorTests(unittest.TestCase):
    """Cada test crea su propio perfil fixture temporal (uuid en el id) para
    no interferir entre tests si corren en paralelo, y lo borra al final."""

    def setUp(self):
        self.profile_id = f"tmp-test-writeonly-{uuid.uuid4().hex[:8]}"
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

    def test_accepts_writeOnly_true_without_read(self):
        # Botón momentáneo del CDU: solo 'write', sin 'read', marcado
        # explícitamente 'writeOnly: true'.
        self.write_control(f"""\
- id: mcdu.exec
  dataType: boolean
  authority: shared
  sdkTier: clientDataArea
  writeOnly: true
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "EVT_CDU_L_EXEC"
    semantics: presses the CDU EXEC key momentarily
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: false
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"Validado: {self.profile_id}", result.stdout)
        self.assertNotIn(f"[control:{self.profile_id}", result.stdout)

    def test_rejects_writeOnly_true_with_read_present(self):
        # Contradicción: writeOnly: true pero además declara 'read'.
        self.write_control(f"""\
- id: mcdu.exec
  dataType: boolean
  authority: shared
  sdkTier: clientDataArea
  writeOnly: true
  read:
    type: clientDataArea
    areaName: PMDG_NG3_Data
    field: CDU_L_ExecPressed
    nativeType: bool
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "EVT_CDU_L_EXEC"
    semantics: presses the CDU EXEC key momentarily
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: false
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[control:{self.profile_id}/mcdu.exec]", result.stdout)

    def test_rejects_control_without_read_and_without_writeOnly(self):
        # Incompleto: no declara 'read' pero tampoco marca 'writeOnly: true'
        # (ni 'readOnly'). El schema exige declarar explícitamente uno u
        # otro para evitar que un perfil incompleto por accidente se cuele.
        self.write_control(f"""\
- id: mcdu.exec
  dataType: boolean
  authority: shared
  sdkTier: clientDataArea
  write:
    type: clientDataEvent
    areaName: PMDG_NG3_Control
    event: "EVT_CDU_L_EXEC"
    semantics: presses the CDU EXEC key momentarily
  synchronization:
    mode: event
    debounceMs: 100
    confirmAfterWrite: false
    timeoutMs: 1000
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[control:{self.profile_id}/mcdu.exec]", result.stdout)


if __name__ == "__main__":
    unittest.main()
