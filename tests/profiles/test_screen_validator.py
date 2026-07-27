#!/usr/bin/env python3
"""
Prueba REAL de tools/validate_profiles.py contra screens/*.yaml
(packages/profile-schema/screen.schema.json).

Este es exactamente el tipo de test que habria atrapado el bug real que se
corrigio en tools/validate_profiles.py: el script asumia que cada archivo
screens/*.yaml era un solo objeto de pantalla en vez de una LISTA de
definiciones de pantalla (mismo patron que controls/*.yaml), y crasheaba con
AttributeError ('list' object has no attribute 'get') al intentar iterar
sobre una lista como si fuera un dict. Este test:

  1. Corre el validador real contra el repo real, que ya incluye
     aircraft-profiles/pmdg-737-900/screens/cdu.yaml (dos pantallas reales,
     cdu_captain / cdu_fo) -- confirma que el fix no revienta y que ese
     archivo real pasa el esquema.
  2. Crea un perfil fixture temporal con un screens/*.yaml INVALIDO (varias
     formas: rows/cols faltantes, sdkTier != clientDataArea, readOnly: false)
     y confirma que el validador lo rechaza con un mensaje [screen:...],
     no con un crash.

No se mockea nada: se invoca tools/validate_profiles.py como subproceso real,
igual que el resto de tests/profiles/. validate_profiles.py escanea
aircraft-profiles/*/manifest.yaml con una ruta ROOT hardcodeada (no acepta un
directorio alternativo por CLI), asi que los casos negativos usan un perfil
fixture TEMPORAL dentro de aircraft-profiles/ (prefijo "tmp-test-screen-")
que se borra en un `finally`/tearDown sin importar el resultado.

Requiere: pip install pyyaml jsonschema (mismas deps que tools/validate_profiles.py).
Uso: python tests/profiles/test_screen_validator.py
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
REAL_PMDG_737_SCREENS = AIRCRAFT_PROFILES_DIR / "pmdg-737-900" / "screens" / "cdu.yaml"

MANIFEST_TEMPLATE = """\
schemaVersion: 1
aircraft:
  id: {profile_id}
  name: Screen Fixture
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
    - "Screen Fixture"
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
  - "Screen Fixture"
fallbackToPartialMatch: true
"""

VALID_SCREEN_YAML = """\
- id: cdu_test
  areaName: PMDG_NG3_CDU_0
  rows: 14
  cols: 24
  sdkTier: clientDataArea
  readOnly: true
  poweredField: Powered
  cell:
    charField: Symbol
    colorField: Color
    flagsField: Flags
    colorValues: 6
"""


class ScreenValidatorRealFixtureTests(unittest.TestCase):
    """Caso positivo contra el archivo REAL del repo (no un fixture propio):
    confirma que el bug lista-vs-objeto ya no revienta el validador."""

    def test_real_pmdg_737_cdu_screens_file_exists_and_is_a_list(self):
        # Sanity check de la forma del archivo real: debe ser una LISTA
        # (no un objeto), que es justo lo que provocaba el AttributeError
        # antes del fix.
        import yaml

        self.assertTrue(REAL_PMDG_737_SCREENS.exists(), "falta screens/cdu.yaml real del 737")
        with open(REAL_PMDG_737_SCREENS, encoding="utf-8") as f:
            screens = yaml.safe_load(f)
        self.assertIsInstance(screens, list)
        self.assertEqual({s["id"] for s in screens}, {"cdu_captain", "cdu_fo"})

    def test_validator_does_not_crash_and_validates_real_737_profile(self):
        result = subprocess.run(
            [sys.executable, str(VALIDATOR)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertNotIn("Traceback", result.stdout + result.stderr,
                          msg=f"validador crasheo:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertNotIn("AttributeError", result.stdout + result.stderr)
        self.assertIn("Validado: pmdg-737-900", result.stdout)
        self.assertNotIn("[screen:pmdg-737-900", result.stdout,
                          msg="las pantallas reales del 737 no deberian tener errores de schema")


class ScreenValidatorFixtureTests(unittest.TestCase):
    """Casos positivo/negativo con un perfil fixture temporal propio, mismo
    patron que test_anti_toggle_validator.py."""

    def setUp(self):
        self.profile_id = f"tmp-test-screen-{uuid.uuid4().hex[:8]}"
        self.profile_dir = AIRCRAFT_PROFILES_DIR / self.profile_id
        (self.profile_dir / "controls").mkdir(parents=True, exist_ok=True)
        (self.profile_dir / "screens").mkdir(parents=True, exist_ok=True)
        (self.profile_dir / "manifest.yaml").write_text(
            MANIFEST_TEMPLATE.format(profile_id=self.profile_id), encoding="utf-8"
        )
        (self.profile_dir / "detection.yaml").write_text(DETECTION_YAML, encoding="utf-8")

    def tearDown(self):
        if self.profile_dir.exists():
            shutil.rmtree(self.profile_dir)

    def write_screen(self, screen_yaml: str):
        (self.profile_dir / "screens" / "cdu.yaml").write_text(screen_yaml, encoding="utf-8")

    def run_validator(self):
        return subprocess.run(
            [sys.executable, str(VALIDATOR)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_accepts_valid_screen_list(self):
        self.write_screen(VALID_SCREEN_YAML)
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertNotIn(f"[screen:{self.profile_id}", result.stdout)

    def test_rejects_screen_missing_rows_and_cols(self):
        self.write_screen("""\
- id: cdu_test
  areaName: PMDG_NG3_CDU_0
  sdkTier: clientDataArea
  readOnly: true
  cell:
    charField: Symbol
    colorField: Color
    flagsField: Flags
    colorValues: 6
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[screen:{self.profile_id}/cdu_test]", result.stdout)

    def test_rejects_screen_with_non_clientDataArea_sdkTier(self):
        self.write_screen("""\
- id: cdu_test
  areaName: PMDG_NG3_CDU_0
  rows: 14
  cols: 24
  sdkTier: standardSimConnect
  readOnly: true
  cell:
    charField: Symbol
    colorField: Color
    flagsField: Flags
    colorValues: 6
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[screen:{self.profile_id}/cdu_test]", result.stdout)

    def test_rejects_screen_with_readOnly_false(self):
        # readOnly esta fijo en 'const: true' en el schema: escritura de
        # botones del CDU esta explicitamente fuera de alcance en esta
        # version del recurso screens/*.yaml.
        self.write_screen("""\
- id: cdu_test
  areaName: PMDG_NG3_CDU_0
  rows: 14
  cols: 24
  sdkTier: clientDataArea
  readOnly: false
  cell:
    charField: Symbol
    colorField: Color
    flagsField: Flags
    colorValues: 6
""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[screen:{self.profile_id}/cdu_test]", result.stdout)

    def test_rejects_screen_as_bare_object_instead_of_list(self):
        # BUG REAL ENCONTRADO por qa-agent (dejado documentado aqui con
        # @expectedFailure originalmente) y CORREGIDO despues en
        # tools/validate_profiles.py: se agrego una guarda de forma
        # (isinstance(screens, list) / isinstance(screen, dict)) antes del
        # bucle, asi que un screens/*.yaml escrito como un dict suelto (en
        # vez de una lista) ya no crashea con AttributeError/Traceback -- el
        # validador ahora lo rechaza con un mensaje [screen:...] normal.
        # Se quita @expectedFailure porque el fix ya esta aplicado y
        # confirmado (ver tools/validate_profiles.py, bloque
        # "if not isinstance(screens, list)").
        self.write_screen("""\
id: cdu_test
areaName: PMDG_NG3_CDU_0
rows: 14
cols: 24
sdkTier: clientDataArea
readOnly: true
cell:
  charField: Symbol
  colorField: Color
  flagsField: Flags
  colorValues: 6
""")
        result = self.run_validator()
        # Comportamiento DESEADO (hoy no se cumple, ver @expectedFailure):
        # el validador deberia rechazar esta forma con un mensaje
        # [screen:...] normal, sin crashear con Traceback.
        self.assertNotIn("Traceback", result.stdout + result.stderr,
                          msg=f"forma objeto-en-vez-de-lista no debe crashear el validador:\n"
                              f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")


if __name__ == "__main__":
    unittest.main()
