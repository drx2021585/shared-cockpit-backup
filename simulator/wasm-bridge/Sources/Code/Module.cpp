// SharedCockpitBridge WASM module -- generado 2026-07-27, primera pieza real
// de simulator/wasm-bridge (decision de arquitectura: ver memoria del proyecto
// "decision_wasm_bridge_pmdg_sync"). Expone 181 L-Vars del PMDG 737NG (las
// mismas usadas por controls/native-toggle-switches.yaml, portadas de la
// instalacion real de YourControls) hacia un Client Data Area propio
// ("SharedCockpitBridge_LVars"), leible desde apps/simulator-bridge (C#) igual
// que ya se lee PMDG_NG3_Data -- mismo mecanismo, area propia en vez de la de
// PMDG. Sin esto, los 181 switches de native-toggle-switches.yaml solo se
// pueden ESCRIBIR (confirmado real contra MSFS 2026-07-27), nunca leer de
// vuelta.
//
// Patron basado en el sample oficial del SDK
// (Samples/DevmodeProjects/Misc/StandaloneModule/Sources/Code/Module.cpp):
// modulo standalone (content_type MISC en el manifest, sin panel.cfg, carga
// automatica al iniciar el sim), SimConnect completo disponible dentro del
// WASM. L-Vars leidas via register_named_variable/get_named_variable_value
// (MSFS/Legacy/gauges.h) -- API de gauge clasica, disponible tambien en
// modulos standalone.

#include <MSFS/MSFS.h>
#include <MSFS/MSFS_WindowsTypes.h>
#include <MSFS/Legacy/gauges.h>
#include <SimConnect.h>
#include <cstdio>
#include <cstring>

static HANDLE g_hSimConnect = 0;

#define NUM_LVARS 181

static const char* const g_lvarNames[NUM_LVARS] = {
    "L:switch_01_73X",
    "L:switch_05_73X",
    "L:switch_06_73X",
    "L:switch_12_73X",
    "L:switch_14_73X",
    "L:switch_18_73X",
    "L:switch_37_73X",
    "L:switch_38_73X",
    "L:switch_39_73X",
    "L:switch_40_73X",
    "L:switch_45_73X",
    "L:switch_46_73X",
    "L:switch_63_73X",
    "L:switch_65_73X",
    "L:switch_67_73X",
    "L:switch_73_73X",
    "L:switch_93_73X",
    "L:switch_96_73X",
    "L:switch_97_73X",
    "L:switch_103_73X",
    "L:switch_105_73X",
    "L:switch_106_73X",
    "L:switch_113_73X",
    "L:switch_114_73X",
    "L:switch_115_73X",
    "L:switch_116_73X",
    "L:switch_117_73X",
    "L:switch_122_73X",
    "L:switch_124_73X",
    "L:switch_125_73X",
    "L:switch_126_73X",
    "L:switch_135_73X",
    "L:switch_136_73X",
    "L:switch_138_73X",
    "L:switch_139_73X",
    "L:switch_140_73X",
    "L:switch_141_73X",
    "L:switch_156_73X",
    "L:switch_157_73X",
    "L:switch_158_73X",
    "L:switch_165_73X",
    "L:switch_166_73X",
    "L:switch_167_73X",
    "L:switch_168_73X",
    "L:switch_187_73X",
    "L:switch_196_73X",
    "L:switch_199_73X",
    "L:switch_209_73X",
    "L:switch_210_73X",
    "L:switch_211_73X",
    "L:switch_212_73X",
    "L:switch_224_73X",
    "L:switch_231_73X",
    "L:switch_257_73X",
    "L:switch_264_73X",
    "L:switch_268_73X",
    "L:switch_271_73X",
    "L:switch_277_73X",
    "L:switch_279_73X",
    "L:switch_280_73X",
    "L:switch_281_73X",
    "L:switch_282_73X",
    "L:switch_283_73X",
    "L:switch_284_73X",
    "L:switch_285_73X",
    "L:switch_286_73X",
    "L:switch_287_73X",
    "L:switch_288_73X",
    "L:switch_289_73X",
    "L:switch_290_73X",
    "L:switch_298_73X",
    "L:switch_311_73X",
    "L:switch_325_73X",
    "L:switch_356_73X",
    "L:switch_366_73X",
    "L:switch_378_73X",
    "L:switch_380_73X",
    "L:switch_406_73X",
    "L:switch_407_73X",
    "L:switch_412_73X",
    "L:switch_422_73X",
    "L:switch_497_73X",
    "L:switch_498_73X",
    "L:switch_501_73X",
    "L:switch_503_73X",
    "L:switch_505_73X",
    "L:switch_680_73X",
    "L:switch_681_73X",
    "L:switch_688_73X",
    "L:switch_689_73X",
    "L:switch_693_73X",
    "L:switch_709_73X",
    "L:switch_710_73X",
    "L:switch_711_73X",
    "L:switch_712_73X",
    "L:switch_739_73X",
    "L:switch_740_73X",
    "L:switch_741_73X",
    "L:switch_742_73X",
    "L:switch_743_73X",
    "L:switch_744_73X",
    "L:switch_745_73X",
    "L:switch_746_73X",
    "L:switch_747_73X",
    "L:switch_748_73X",
    "L:switch_749_73X",
    "L:switch_750_73X",
    "L:switch_751_73X",
    "L:switch_753_73X",
    "L:switch_755_73X",
    "L:switch_763_73X",
    "L:switch_765_73X",
    "L:switch_767_73X",
    "L:switch_798_73X",
    "L:switch_801_73X",
    "L:switch_803_73X",
    "L:switch_806_73X",
    "L:switch_818_73X",
    "L:switch_820_73X",
    "L:switch_830_73X",
    "L:switch_855_73X",
    "L:switch_856_73X",
    "L:switch_857_73X",
    "L:switch_858_73X",
    "L:switch_859_73X",
    "L:switch_860_73X",
    "L:switch_861_73X",
    "L:switch_862_73X",
    "L:switch_863_73X",
    "L:switch_864_73X",
    "L:switch_865_73X",
    "L:switch_866_73X",
    "L:switch_867_73X",
    "L:switch_869_73X",
    "L:switch_871_73X",
    "L:switch_872_73X",
    "L:switch_874_73X",
    "L:switch_875_73X",
    "L:switch_876_73X",
    "L:switch_880_73X",
    "L:switch_884_73X",
    "L:switch_886_73X",
    "L:switch_887_73X",
    "L:switch_888_73X",
    "L:switch_891_73X",
    "L:switch_892_73X",
    "L:switch_895_73X",
    "L:switch_896_73X",
    "L:switch_911_73X",
    "L:switch_974_73X",
    "L:switch_975_73X",
    "L:switch_976_73X",
    "L:switch_977_73X",
    "L:switch_978_73X",
    "L:switch_979_73X",
    "L:switch_981_73X",
    "L:switch_1006_73X",
    "L:switch_1007_73X",
    "L:switch_1008_73X",
    "L:switch_1009_73X",
    "L:switch_1015_73X",
    "L:switch_2000_73X",
    "L:switch_2001_73X",
    "L:switch_2002_73X",
    "L:switch_2006_73X",
    "L:switch_2007_73X",
    "L:switch_2008_73X",
    "L:switch_2009_73X",
    "L:switch_2010_73X",
    "L:switch_2011_73X",
    "L:switch_2012_73X",
    "L:switch_2013_73X",
    "L:switch_2014_73X",
    "L:switch_2019_73X",
    "L:switch_2020_73X",
    "L:switch_2981_73X",
    "L:switch_4552_73X",
    "L:switch_6971_73X",
    "L:switch_6981_73X",
    "L:switch_6991_73X",
    "L:switch_7651_73X",
};

static ID g_lvarIds[NUM_LVARS];
// Empaquetado como 1 byte por switch (0/1), no double -- reusa exactamente el
// mismo formato que ya soporta apps/simulator-bridge para PMDG_NG3_Data
// (ClientDataNativeType.Bool, 1 byte, "raw != 0" = true), sin necesitar
// extender el esquema de perfiles para floats todavia (ver nota en
// packages/profile-schema sobre floats/int bloqueados por ahora).
static unsigned char g_lvarValues[NUM_LVARS];
static double g_lastRaw[NUM_LVARS];

enum eClientDataId
{
    CLIENT_DATA_ID_LVARS = 0,
};

enum eClientDataDefinitionId
{
    DEFINITION_ID_LVARS = 0,
};

enum eEvents
{
    EVENT_FRAME,
};

void CALLBACK MyDispatchProc(SIMCONNECT_RECV* pData, DWORD cbData, void* pContext);

extern "C" MSFS_CALLBACK void module_init(void)
{
    // Registrar todas las L-Vars conocidas -- register_named_variable crea la
    // variable si todavia no existe (no falla si el avion activo no es el
    // 737, simplemente queda en 0; el bridge C# solo debe confiar en estos
    // valores cuando el perfil activo coincide, igual que ya hace con
    // PMDG_NG3_Data).
    for (int i = 0; i < NUM_LVARS; i++)
    {
        g_lvarIds[i] = register_named_variable(g_lvarNames[i]);
        g_lvarValues[i] = 0;
        g_lastRaw[i] = 0.0;
    }

    g_hSimConnect = 0;
    HRESULT hr = SimConnect_Open(&g_hSimConnect, "SharedCockpitBridge", NULL, 0, 0, 0);
    if (hr != S_OK)
    {
        fprintf(stderr, "SharedCockpitBridge: no se pudo abrir SimConnect.\n");
        return;
    }

    // Client Data Area propia (a diferencia de PMDG_NG3_Data, que PMDG crea y
    // nosotros solo mapeamos): aqui SOMOS los dueños, usamos
    // SimConnect_CreateClientData para reservar el area antes de que ningun
    // cliente externo intente suscribirse.
    hr = SimConnect_MapClientDataNameToID(g_hSimConnect, "SharedCockpitBridge_LVars", CLIENT_DATA_ID_LVARS);
    if (hr != S_OK)
    {
        fprintf(stderr, "SharedCockpitBridge: MapClientDataNameToID fallo.\n");
        return;
    }

    hr = SimConnect_CreateClientData(g_hSimConnect, CLIENT_DATA_ID_LVARS, sizeof(g_lvarValues), SIMCONNECT_CREATE_CLIENT_DATA_FLAG_DEFAULT);
    if (hr != S_OK)
    {
        fprintf(stderr, "SharedCockpitBridge: CreateClientData fallo.\n");
        return;
    }

    hr = SimConnect_AddToClientDataDefinition(g_hSimConnect, DEFINITION_ID_LVARS, 0, sizeof(g_lvarValues), 0, SIMCONNECT_UNUSED);
    if (hr != S_OK)
    {
        fprintf(stderr, "SharedCockpitBridge: AddToClientDataDefinition fallo.\n");
        return;
    }

    // "Frame" = evento de sistema estandar, dispara cada fotograma. Se podria
    // bajar la frecuencia (ej. "1sec") si el volumen de datos crece mucho,
    // pero para 181 bytes por fotograma no hay problema real de ancho de
    // banda local.
    hr = SimConnect_SubscribeToSystemEvent(g_hSimConnect, EVENT_FRAME, "Frame");
    if (hr != S_OK)
    {
        fprintf(stderr, "SharedCockpitBridge: SubscribeToSystemEvent(Frame) fallo.\n");
        return;
    }

    hr = SimConnect_CallDispatch(g_hSimConnect, MyDispatchProc, NULL);
    if (hr != S_OK)
    {
        fprintf(stderr, "SharedCockpitBridge: CallDispatch fallo.\n");
        return;
    }
}

extern "C" MSFS_CALLBACK void module_deinit(void)
{
    if (!g_hSimConnect)
        return;
    SimConnect_Close(g_hSimConnect);
    g_hSimConnect = 0;
}

static void PushLVarsToClientData()
{
    bool changed = false;
    for (int i = 0; i < NUM_LVARS; i++)
    {
        double v = get_named_variable_value(g_lvarIds[i]);
        if (v != g_lastRaw[i])
        {
            g_lastRaw[i] = v;
            g_lvarValues[i] = (v != 0.0) ? 1 : 0;
            changed = true;
        }
    }

    // Solo transmitir cuando algo cambio -- evita spamear SetClientData 30-60
    // veces por segundo cuando nada se movio (igual de principio que el resto
    // del bridge: "Changed" en vez de polling ciego).
    if (changed)
    {
        SimConnect_SetClientData(g_hSimConnect, CLIENT_DATA_ID_LVARS, DEFINITION_ID_LVARS, 0, 0, sizeof(g_lvarValues), g_lvarValues);
    }
}

void CALLBACK MyDispatchProc(SIMCONNECT_RECV* pData, DWORD cbData, void* pContext)
{
    switch (pData->dwID)
    {
    case SIMCONNECT_RECV_ID_EVENT:
    {
        SIMCONNECT_RECV_EVENT* evt = (SIMCONNECT_RECV_EVENT*)pData;
        if (evt->uEventID == EVENT_FRAME)
        {
            PushLVarsToClientData();
        }
        break;
    }
    default:
        break;
    }
}
