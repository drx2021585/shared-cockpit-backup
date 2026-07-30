#!/usr/bin/env python3
"""
Prueba REAL de tools/validate_profiles.py para mantener alineados
manifest.yaml y capabilities.yaml.

El porcentaje visible en la UI sale de manifest.yaml, mientras que
capabilities.yaml es documentacion expandida para QA. Si ambos divergen, el
usuario ve un numero y el repo documenta otro. Este test fuerza que el
validador real detecte esa deriva.
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
  name: Capabilities Fixture
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
    - "Capabilities Fixture"
capabilities:
  flightControls: full
  autopilot: partial
  electrical: none
  hydraulics: none
  radios: none
  mcdu: partial
  failures: none
"""

CAPABILITIES_OK = """\
systems:
  flightControls:
    level: full
    controls: []
    missing: []
  autopilot:
    level: partial
    controls: []
    missing: []
  electrical:
    level: none
    controls: []
    missing: []
  hydraulics:
    level: none
    controls: []
    missing: []
  radios:
    level: none
    controls: []
    missing: []
  mcdu:
    level: partial
    controls: []
    missing: []
  failures:
    level: none
    controls: []
    missing: []
"""


class CapabilitiesAlignmentValidatorTests(unittest.TestCase):
    def setUp(self):
        self.profile_id = f"tmp-test-capabilities-{uuid.uuid4().hex[:8]}"
        self.profile_dir = AIRCRAFT_PROFILES_DIR / self.profile_id
        (self.profile_dir / "controls").mkdir(parents=True, exist_ok=True)
        (self.profile_dir / "manifest.yaml").write_text(
            MANIFEST_TEMPLATE.format(profile_id=self.profile_id), encoding="utf-8"
        )

    def tearDown(self):
        if self.profile_dir.exists():
            shutil.rmtree(self.profile_dir)

    def run_validator(self):
        return subprocess.run(
            [sys.executable, str(VALIDATOR)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_accepts_aligned_capabilities_yaml(self):
        (self.profile_dir / "capabilities.yaml").write_text(CAPABILITIES_OK, encoding="utf-8")
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertNotIn(f"[capabilities:{self.profile_id}", result.stdout)

    def test_rejects_mismatched_level_between_manifest_and_capabilities(self):
        (self.profile_dir / "capabilities.yaml").write_text(
            CAPABILITIES_OK.replace("level: full", "level: partial", 1),
            encoding="utf-8",
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[capabilities:{self.profile_id}/flightControls]", result.stdout)
        self.assertIn("desalineado", result.stdout)

    def test_rejects_missing_core_system_in_capabilities_yaml(self):
        (self.profile_dir / "capabilities.yaml").write_text(
            CAPABILITIES_OK.replace(
                "  mcdu:\n    level: partial\n    controls: []\n    missing: []\n",
                "",
            ),
            encoding="utf-8",
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn(f"[capabilities:{self.profile_id}/mcdu]", result.stdout)
        self.assertIn("falta en capabilities.yaml", result.stdout)


if __name__ == "__main__":
    unittest.main()
