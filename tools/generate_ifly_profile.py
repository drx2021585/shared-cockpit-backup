"""Regenera aircraft-profiles/ifly-737-max8/controls/*.yaml desde el modelo
real del addon iFly 737 MAX 8 instalado.

Uso:

    python3 tools/generate_ifly_profile.py \
        ".../ifly-aircraft-737max8/SimObjects/Airplanes/iFly 737-MAX8/model/iFly737Max_INTERIOR.xml" \
        aircraft-profiles/ifly-737-max8/controls

Por que existe: son ~1050 controles, y escribirlos a mano garantiza errores de
transcripcion. Mismo criterio que se uso para
aircraft-profiles/pmdg-737-900/controls/native-toggle-switches.yaml.

Que hace exactamente (ver aircraft-profiles/ifly-737-max8/NOTAS-SDK.md para el
razonamiento completo):

 1. Recorre cada <Component> del modelo interior que tenga <CallbackCode>.
 2. Saca la L-Var de estado de su <ANIM_CODE> (L:VC_<control>_VAL) y los
    codigos de comando de su <CallbackCode> (el entero que se escribe en la
    L-Var de trigger del sistema, ej. L:VC_Fuel_trigger_VAL).
 3. Clasifica el control en selector posicional / boton momentaneo / codigo
    unico segun que eventos de mouse maneja, y emite el RPN de escritura
    correspondiente (write.type: calculatorCode).

NO corre en CI ni al construir: es una herramienta manual, solo hace falta si
iFly publica una version nueva del avion con controles distintos. Despues de
correrla, validar con: python3 tools/validate_profiles.py
"""

import os
import re
import sys
from collections import defaultdict

# ---------------------------------------------------------------------------
# 1. Extraccion desde el XML del modelo
# ---------------------------------------------------------------------------

COMPONENT_RE = re.compile(r"<Component\s+[iI][dD]=\"([^\"]+)\"(.*?)</Component>", re.S)
ANIM_CODE_RE = re.compile(r"<ANIM_CODE>\s*\(L:([A-Za-z0-9_]+),\s*number\)\s*</ANIM_CODE>", re.S)
ANIM_LENGTH_RE = re.compile(r"<ANIM_LENGTH>\s*([0-9]+)\s*</ANIM_LENGTH>")
TOOLTIP_RE = re.compile(r"<TOOLTIPID>([^<]*)</TOOLTIPID>")
CALLBACK_RE = re.compile(r"<CallbackCode>(.*?)</CallbackCode>", re.S | re.I)
# (M:Event) 'LeftSingle' scmp 0 == if{ 2 (>L:VC_Gear_trigger_VAL,number) }
BRANCH_RE = re.compile(r"\(M:Event\)\s*'([A-Za-z]+)'\s*scmp\s*0\s*==\s*if\{(.*?)\}", re.S)
TRIGGER_RE = re.compile(r"([0-9]+)\s*\(>L:(VC_[A-Za-z0-9_]*_trigger_VAL)\s*,\s*number\)")


def extract(xml_path):
    src = open(xml_path, encoding="utf-8", errors="replace").read()
    rows = []
    for cid, body in COMPONENT_RE.findall(src):
        cb = CALLBACK_RE.search(body)
        if not cb:
            continue

        events, system = {}, None
        for mouse_event, branch in BRANCH_RE.findall(cb.group(1)):
            trig = TRIGGER_RE.search(branch)
            if not trig:
                continue
            events[mouse_event] = int(trig.group(1))
            system = trig.group(2) if system is None else system
        if not events:
            continue

        anim = ANIM_CODE_RE.search(body)
        length = ANIM_LENGTH_RE.search(body)
        tip = TOOLTIP_RE.search(body)
        rows.append(
            {
                "componentId": cid,
                "tooltip": tip.group(1).strip() if tip else "",
                "stateLvar": anim.group(1) if anim else None,
                "animLength": int(length.group(1)) if length else None,
                "system": system,
                "events": events,
            }
        )
    return rows


# ---------------------------------------------------------------------------
# 2. Generacion del YAML
# ---------------------------------------------------------------------------

SYSTEM_FILES = {
    "VC_Air_Systems_trigger_VAL": ("air", "Aire acondicionado y presurizacion"),
    "VC_Anti_Ice_trigger_VAL": ("anti-ice", "Proteccion de hielo y lluvia"),
    "VC_Automatic_Flight_trigger_VAL": ("autoflight", "MCP / piloto automatico"),
    "VC_Communications_trigger_VAL": ("communications", "ACP, RTP, interfono, CVR"),
    "VC_EFB_trigger_VAL": ("efb", "Electronic Flight Bag (tablets CAPT/FO)"),
    "VC_Electrical_trigger_VAL": ("electrical", "Sistema electrico"),
    "VC_Engine_APU_trigger_VAL": ("engine", "Motores y APU"),
    "VC_Fire_Protection_trigger_VAL": ("fire-protection", "Deteccion y extincion de fuego"),
    "VC_Flight_Control_trigger_VAL": ("flight-controls", "Controles de vuelo, flaps, spoilers, trim"),
    "VC_Fuel_trigger_VAL": ("fuel", "Combustible"),
    "VC_Gear_trigger_VAL": ("gear", "Tren de aterrizaje y frenos"),
    "VC_Hydraulics_trigger_VAL": ("hydraulics", "Sistema hidraulico"),
    "VC_Instruments_trigger_VAL": ("instruments", "EFIS, DSPY, ISFD, registradores"),
    "VC_Miscellaneous_trigger_VAL": ("misc", "Asientos, ventanas, viseras, luces de lectura"),
    "VC_Navigation_trigger_VAL": ("navigation", "CDU, IRS, NAV, transponder, ADF"),
    "VC_Warning_Systems_trigger_VAL": ("warnings", "Avisos, GPWS, master caution"),
}

SYSTEM_IDS = {k: v[0].replace("-", "_") for k, v in SYSTEM_FILES.items()}

HEADER = """\
# GENERADO MECANICAMENTE por tools/generate_ifly_profile.py -- no editar a mano.
#
# Fuente: SimObjects/Airplanes/iFly 737-MAX8/model/iFly737Max_INTERIOR.xml del
# paquete iFly 737 MAX 8 v1.1.0.0 realmente instalado (copia de referencia de
# Darwin en apps/desktop-ui/recurso/ifly-aircraft-737max8/). Cada control sale
# del <Component> real: la L-Var de estado del <ANIM_CODE> y los codigos de
# comando del <CallbackCode>.
#
# Sistema: {title}
# Mecanismo de iFly (verificado leyendo el XML, no supuesto): la cabina NO tiene
# eventos H:/K:/B:. Un clic escribe un CODIGO ENTERO en la L-Var de trigger del
# sistema ({trigger}) y el WASM de iFly hace el resto,
# publicando el resultado en L:VC_<control>_VAL.
#
#   Lectura  : L:VC_<control>_VAL via FSUIPC7 (FsuipcLVarClient, area
#              "SharedCockpitBridge_LVars" -- 'field' es el nombre crudo de la
#              L-Var, que es exactamente lo que espera ReadLVar).
#   Escritura: calculator code RPN ejecutado por MSFSVariableServices de FSUIPC7
#              (write.type: calculatorCode, mecanismo ya confirmado en vivo para
#              el PMDG). El RPN compara el estado real contra el valor pedido y
#              solo entonces dispara el codigo -- por eso esto respeta la regla
#              anti-TOGGLE aunque iFly no exponga ningun SET absoluto.
#
# LIMITACION HONESTA: una escritura avanza UN paso hacia el destino. Para un
# selector de varias posiciones hacen falta varias escrituras (cada cambio de
# estado del otro piloto vuelve a disparar una). Ademas la POLARIDAD (que rueda
# arriba = valor mayor) se asume a partir de la convencion del XML y NO esta
# verificada en vivo: si en algun control resultara invertida, la escritura da
# un paso en sentido contrario -- un solo paso, no un bucle -- y queda visible
# en el confirmAfterWrite. Validar por sistema contra MSFS real antes de confiar.
"""


def snake(component_id):
    name = component_id[3:] if component_id.startswith("VC_") else component_id
    name = re.sub(r"[^A-Za-z0-9]+", "_", name)
    return re.sub(r"_+", "_", name).strip("_").lower()


def classify(events):
    """Devuelve (kind, a, b) siguiendo la convencion real del XML de iFly.

    El par rueda arriba/abajo es la fuente de verdad direccional cuando existe y
    es distinto: en los 208 controles "limpios" ademas se cumple
    LeftSingle == WheelDown y RightSingle == WheelUp, y en los pocos casos donde
    no coinciden (ej. VC_ADF_Left_Mode_SW) la rueda sigue siendo coherente.
    Codigos de rueda en 0 significan "la rueda no hace nada en este control".
    """
    wu, wd = events.get("WheelUp"), events.get("WheelDown")
    if wu and wd and wu != wd:
        return "positional", wu, wd
    ls, rs = events.get("LeftSingle"), events.get("RightSingle")
    if rs is not None and rs != ls and not wu and not wd:
        return "positional", rs, ls
    if "LeftRelease" in events:
        return "momentary", ls, events["LeftRelease"]
    return "single", ls, None


def yaml_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build(rows, out_dir):
    by_file = defaultdict(list)
    seen_ids = {}
    stats = defaultdict(int)

    for r in rows:
        system_var = r["system"]
        file_name, _ = SYSTEM_FILES[system_var]
        prefix = SYSTEM_IDS[system_var]
        kind, a, b = classify(r["events"])
        state = r["stateLvar"]

        control_id = f"{prefix}.{snake(r['componentId'])}"
        if control_id in seen_ids:
            raise SystemExit(
                f"id duplicado: {control_id} ({r['componentId']} vs {seen_ids[control_id]})"
            )
        seen_ids[control_id] = r["componentId"]

        tooltip = r["tooltip"] or "(sin tooltip en el modelo)"
        lines = [
            f"- id: {control_id}",
            f"  # {tooltip} -- nodo {r['componentId']} del modelo iFly.",
        ]

        if kind == "positional" and state:
            stats["positional"] += 1
            code = (
                f"(L:{state},number) $value < if{{ {a} (>L:{system_var},number) }} "
                f"(L:{state},number) $value > if{{ {b} (>L:{system_var},number) }}"
            )
            lines += [
                f"  # Selector/perilla de {r['animLength']} pasos. Escritura direccional: un solo",
                f"  # paso hacia el valor pedido por escritura (codigo {a} sube, {b} baja); si ya",
                "  # esta en el destino no dispara nada. NO es un TOGGLE ciego.",
                "  dataType: number",
                "  authority: shared",
                "  read:",
                "    type: clientDataArea",
                '    areaName: "SharedCockpitBridge_LVars"',
                f'    field: "L:{state}"',
                "    nativeType: float",
                "  write:",
                "    type: calculatorCode",
                f"    name: {yaml_str(code)}",
                "  synchronization:",
                "    mode: event",
                "    confirmAfterWrite: true",
                "    debounceMs: 150",
            ]

        elif kind == "positional":
            stats["positional_writeonly"] += 1
            code = (
                f"$value 0 > if{{ {a} (>L:{system_var},number) }} "
                f"els{{ {b} (>L:{system_var},number) }}"
            )
            lines += [
                "  # Sin L-Var de estado en el modelo: solo escritura. true = paso arriba",
                f"  # (codigo {a}), false = paso abajo (codigo {b}). Sin confirmacion posible.",
                "  dataType: boolean",
                "  authority: shared",
                "  writeOnly: true",
                "  write:",
                "    type: calculatorCode",
                f"    name: {yaml_str(code)}",
                "  synchronization:",
                "    mode: event",
                "    confirmAfterWrite: false",
                "    debounceMs: 50",
            ]

        elif kind == "momentary":
            code = (
                f"$value 0 > if{{ {a} (>L:{system_var},number) }} "
                f"els{{ {b} (>L:{system_var},number) }}"
            )
            lines += [
                f"  # Boton momentaneo: true = pulsar (codigo {a}), false = soltar (codigo {b}).",
                "  # Set explicito en ambos sentidos, no un TOGGLE.",
                "  dataType: boolean",
                "  authority: shared",
            ]
            if state:
                stats["momentary"] += 1
                lines += [
                    "  read:",
                    "    type: clientDataArea",
                    '    areaName: "SharedCockpitBridge_LVars"',
                    f'    field: "L:{state}"',
                    "    nativeType: float",
                ]
            else:
                stats["momentary_writeonly"] += 1
                lines.append("  writeOnly: true")
            lines += [
                "  write:",
                "    type: calculatorCode",
                f"    name: {yaml_str(code)}",
                "  synchronization:",
                "    mode: event",
                f"    confirmAfterWrite: {'true' if state else 'false'}",
                "    debounceMs: 50",
            ]

        else:  # single
            lines.append("  dataType: number" if state else "  dataType: boolean")
            lines.append("  authority: shared")
            if state:
                stats["single"] += 1
                code = f"(L:{state},number) $value != if{{ {a} (>L:{system_var},number) }}"
                lines += [
                    f"  # Unico codigo de comando ({a}): iFly avanza el control a su siguiente",
                    "  # posicion. Se dispara SOLO si el estado real difiere del pedido, asi que",
                    "  # converge al valor del otro piloto en vez de alternar a ciegas.",
                    "  read:",
                    "    type: clientDataArea",
                    '    areaName: "SharedCockpitBridge_LVars"',
                    f'    field: "L:{state}"',
                    "    nativeType: float",
                ]
            else:
                stats["single_writeonly"] += 1
                code = f"$value 0 > if{{ {a} (>L:{system_var},number) }}"
                lines += [
                    f"  # Pulso unico (codigo {a}) sin L-Var de estado en el modelo: solo escritura,",
                    "  # se dispara al recibir true y no hay nada que confirmar.",
                    "  writeOnly: true",
                ]
            lines += [
                "  write:",
                "    type: calculatorCode",
                f"    name: {yaml_str(code)}",
                "  synchronization:",
                "    mode: event",
                f"    confirmAfterWrite: {'true' if state else 'false'}",
                "    debounceMs: 100",
            ]

        by_file[file_name].append("\n".join(lines))

    os.makedirs(out_dir, exist_ok=True)
    for file_name, blocks in sorted(by_file.items()):
        system_var = next(k for k, v in SYSTEM_FILES.items() if v[0] == file_name)
        title = SYSTEM_FILES[system_var][1]
        path = os.path.join(out_dir, f"{file_name}.yaml")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(HEADER.format(title=title, trigger=f"L:{system_var}"))
            f.write("\n")
            f.write("\n\n".join(blocks))
            f.write("\n")
        print(f"{path}: {len(blocks)} controles")

    print()
    print("totales:", dict(stats), "=", sum(stats.values()))


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)

    xml_path, out_dir = sys.argv[1], sys.argv[2]
    rows = extract(xml_path)
    # iFly_Mouse_Null / VC_Mouse_Null_* son zonas de captura de raton sin
    # control real detras -- se descartan a proposito.
    rows = [r for r in rows if "Mouse_Null" not in r["componentId"]]
    print(f"componentes interactivos en el modelo: {len(rows)}")
    build(rows, out_dir)


if __name__ == "__main__":
    main()
