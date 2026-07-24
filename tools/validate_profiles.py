#!/usr/bin/env python3
"""
Valida todos los perfiles de aeronave en aircraft-profiles/ contra
packages/profile-schema/. Uso del qa-agent en cada sprint.

Requiere: pip install pyyaml jsonschema --break-system-packages
"""
import glob
import json
import os
import sys

import yaml
from jsonschema import Draft7Validator

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load_schema(name):
    with open(os.path.join(ROOT, "packages", "profile-schema", name)) as f:
        return json.load(f)

def main():
    manifest_schema = load_schema("manifest.schema.json")
    control_schema = load_schema("control.schema.json")
    manifest_validator = Draft7Validator(manifest_schema)
    control_validator = Draft7Validator(control_schema)

    errors_found = False

    for manifest_path in glob.glob(os.path.join(ROOT, "aircraft-profiles", "*", "manifest.yaml")):
        profile_dir = os.path.dirname(manifest_path)
        profile_id = os.path.basename(profile_dir)
        with open(manifest_path) as f:
            manifest = yaml.safe_load(f)

        for err in manifest_validator.iter_errors(manifest):
            errors_found = True
            print(f"[manifest:{profile_id}] {err.message} at {list(err.path)}")

        for control_file in glob.glob(os.path.join(profile_dir, "controls", "*.yaml")):
            with open(control_file) as f:
                controls = yaml.safe_load(f) or []
            for control in controls:
                for err in control_validator.iter_errors(control):
                    errors_found = True
                    cid = control.get("id", "?")
                    print(f"[control:{profile_id}/{cid}] {err.message}")

                # regla anti-TOGGLE: heurística simple sobre el nombre del evento de escritura
                write_name = (control.get("write") or {}).get("name", "").upper()
                if "TOGGLE" in write_name and control.get("dataType") == "boolean":
                    errors_found = True
                    print(f"[anti-toggle:{profile_id}/{control.get('id')}] "
                          f"write event '{write_name}' parece un TOGGLE crudo; "
                          f"usar SET_ON/SET_OFF/SET_VALUE explícito.")

        print(f"Validado: {profile_id}")

    if errors_found:
        print("\nFALLÓ la validación de perfiles.")
        sys.exit(1)
    print("\nTodos los perfiles son válidos.")

if __name__ == "__main__":
    main()
