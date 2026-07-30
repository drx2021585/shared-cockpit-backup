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
    with open(os.path.join(ROOT, "packages", "profile-schema", name), encoding="utf-8") as f:
        return json.load(f)

def validate_capabilities_alignment(profile_id, profile_dir, manifest, *, errors_found_ref):
    capabilities_path = os.path.join(profile_dir, "capabilities.yaml")
    if not os.path.exists(capabilities_path):
        return

    with open(capabilities_path, encoding="utf-8") as f:
        capabilities_doc = yaml.safe_load(f) or {}

    manifest_capabilities = manifest.get("capabilities") or {}
    documented_systems = (capabilities_doc.get("systems") or {}) if isinstance(capabilities_doc, dict) else {}

    for system_name, manifest_level in manifest_capabilities.items():
        documented = documented_systems.get(system_name)
        if documented is None:
            errors_found_ref[0] = True
            print(f"[capabilities:{profile_id}/{system_name}] falta en capabilities.yaml pero existe en manifest.yaml")
            continue

        documented_level = documented.get("level") if isinstance(documented, dict) else None
        if documented_level != manifest_level:
            errors_found_ref[0] = True
            print(
                f"[capabilities:{profile_id}/{system_name}] "
                f"desalineado: manifest.yaml={manifest_level!r}, capabilities.yaml={documented_level!r}"
            )

def main():
    manifest_schema = load_schema("manifest.schema.json")
    control_schema = load_schema("control.schema.json")
    screen_schema = load_schema("screen.schema.json")
    manifest_validator = Draft7Validator(manifest_schema)
    control_validator = Draft7Validator(control_schema)
    screen_validator = Draft7Validator(screen_schema)

    errors_found = False

    for manifest_path in glob.glob(os.path.join(ROOT, "aircraft-profiles", "*", "manifest.yaml")):
        profile_dir = os.path.dirname(manifest_path)
        profile_id = os.path.basename(profile_dir)
        with open(manifest_path, encoding="utf-8") as f:
            manifest = yaml.safe_load(f)

        for err in manifest_validator.iter_errors(manifest):
            errors_found = True
            print(f"[manifest:{profile_id}] {err.message} at {list(err.path)}")

        errors_found_ref = [errors_found]
        validate_capabilities_alignment(profile_id, profile_dir, manifest, errors_found_ref=errors_found_ref)
        errors_found = errors_found_ref[0]

        for control_file in glob.glob(os.path.join(profile_dir, "controls", "*.yaml")):
            with open(control_file, encoding="utf-8") as f:
                controls = yaml.safe_load(f) or []
            for control in controls:
                for err in control_validator.iter_errors(control):
                    errors_found = True
                    cid = control.get("id", "?")
                    print(f"[control:{profile_id}/{cid}] {err.message}")

                # regla anti-TOGGLE: heurística simple sobre el nombre del evento de escritura
                write = control.get("write") or {}
                write_name = str(write.get("name", "")).upper()
                if "TOGGLE" in write_name and control.get("dataType") == "boolean":
                    errors_found = True
                    print(f"[anti-toggle:{profile_id}/{control.get('id')}] "
                          f"write event '{write_name}' parece un TOGGLE crudo; "
                          f"usar SET_ON/SET_OFF/SET_VALUE explícito.")

                # regla anti-TOGGLE (defensa en profundidad) para write.type: clientDataEvent
                # (ej. PMDG_NG3_Control): el esquema ya exige 'semantics' no vacío vía JSON
                # Schema, pero aquí además rechazamos semantics vacías/triviales o que solo
                # digan "toggle" sin describir el efecto determinístico del Event.
                if write.get("type") == "clientDataEvent":
                    semantics = str(write.get("semantics", "")).strip()
                    event_name = str(write.get("event", "")).upper()
                    if not semantics:
                        errors_found = True
                        print(f"[anti-toggle:{profile_id}/{control.get('id')}] "
                              f"write.type clientDataEvent sin 'semantics' documentada; "
                              f"cada Event debe describir su efecto set determinístico "
                              f"(ver packages/profile-schema/README.md).")
                    elif semantics.lower() in {"toggle", "toggles"}:
                        errors_found = True
                        print(f"[anti-toggle:{profile_id}/{control.get('id')}] "
                              f"semantics '{semantics}' es un TOGGLE crudo disfrazado; "
                              f"describe el estado explícito que fija el Event "
                              f"(ej. \"sets IRS mode selector to NAV\").")
                    if "TOGGLE" in event_name and control.get("dataType") == "boolean":
                        errors_found = True
                        print(f"[anti-toggle:{profile_id}/{control.get('id')}] "
                              f"write.event '{event_name}' parece un TOGGLE crudo; "
                              f"cada Event ID del SDK de terceros debe tener efecto set "
                              f"determinístico, no un TOGGLE genérico.")

                # regla anti-TOGGLE (defensa en profundidad) para write.type: nativeEventValue
                # (ej. ROTOR_BRAKE reutilizado como bus de switches por PMDG NG3, ver
                # native-toggle-switches.yaml): mismo criterio que clientDataEvent -- el
                # esquema ya exige 'semantics' no vacía, aquí se rechaza además una
                # semántica trivial que sea solo "toggle"/"toggles" sin describir el
                # mecanismo real (control/switch/param involucrados).
                if write.get("type") == "nativeEventValue":
                    semantics = str(write.get("semantics", "")).strip()
                    if not semantics:
                        errors_found = True
                        print(f"[anti-toggle:{profile_id}/{control.get('id')}] "
                              f"write.type nativeEventValue sin 'semantics' documentada; "
                              f"cada evento+parameter debe describir su efecto real "
                              f"(ver packages/profile-schema/control.schema.json).")
                    elif semantics.lower() in {"toggle", "toggles"}:
                        errors_found = True
                        print(f"[anti-toggle:{profile_id}/{control.get('id')}] "
                              f"semantics '{semantics}' es un TOGGLE crudo disfrazado; "
                              f"describe el mecanismo real (evento, parameter, y por qué "
                              f"no hay SET_ON/SET_OFF disponible).")

        # screens/*.yaml es OPCIONAL: la mayoria de perfiles no tienen pantallas
        # (ej. CDU/MCDU de un SDK de terceros). Si la carpeta no existe, no pasa nada.
        # Cada archivo es una LISTA de definiciones de pantalla (mismo patrón que
        # controls/*.yaml, ej. cdu_captain + cdu_fo en un solo screens/cdu.yaml),
        # no un único objeto.
        for screen_file in glob.glob(os.path.join(profile_dir, "screens", "*.yaml")):
            with open(screen_file, encoding="utf-8") as f:
                screens = yaml.safe_load(f) or []
            # Defensa en profundidad: un autor puede escribir por error un solo
            # objeto suelto (dict) en vez de una lista de pantallas. Un dict es
            # iterable en Python (itera sus claves, strings), así que sin este
            # chequeo explícito el error se vuelve un AttributeError confuso
            # ("'str' object has no attribute 'get'") en vez de un mensaje claro
            # de validación. Detectado por qa-agent (tests/profiles/test_screen_validator.py).
            if not isinstance(screens, list):
                errors_found = True
                print(f"[screen:{profile_id}] {os.path.basename(screen_file)} debe ser "
                      f"una LISTA de definiciones de pantalla (ej. '- id: cdu_captain'), "
                      f"no un único objeto YAML suelto.")
                continue
            for screen in screens:
                if not isinstance(screen, dict):
                    errors_found = True
                    print(f"[screen:{profile_id}] entrada inválida en "
                          f"{os.path.basename(screen_file)}: se esperaba un objeto por "
                          f"pantalla, se encontró {type(screen).__name__}.")
                    continue
                for err in screen_validator.iter_errors(screen):
                    errors_found = True
                    sid = screen.get("id", "?")
                    print(f"[screen:{profile_id}/{sid}] {err.message}")

        print(f"Validado: {profile_id}")

    if errors_found:
        print("\nFALLÓ la validación de perfiles.")
        sys.exit(1)
    print("\nTodos los perfiles son válidos.")

if __name__ == "__main__":
    main()
