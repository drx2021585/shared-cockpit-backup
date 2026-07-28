namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// Tabla de offsets binarios de <c>struct PMDG_NG3_Data</c>, calculada a partir de
/// apps/desktop-ui/Documentation/SDK/PMDG_NG3_SDK.h (Copyright PMDG). SimConnect
/// Client Data Areas se transmiten como un blob binario crudo: para leer un campo
/// hay que conocer su offset y tamaño exactos dentro del struct C original, tal
/// como lo layoutea el compilador de PMDG (MSVC, sin #pragma pack en el header
/// -> alineación natural: miembros de 1 byte (bool/unsigned char/char) sin
/// requisito de alineación, miembros de 4 bytes (unsigned int/int/float)
/// alineados a offset múltiplo de 4, con padding insertado si hace falta).
///
/// IMPORTANTE — alcance honesto de esta tabla:
/// Se transcribió, EN ORDEN EXACTO, desde "IRS_DisplaySelector" hasta
/// "LTS_LowerDUMapBrtKnob" (ver PMDG_NG3_SDK.h líneas ~42-430). Esto cubre el
/// primer tramo original (hasta "LTS_WheelWellSw", línea 307) MÁS la sección
/// "Glareshield en adelante" hasta el final del bloque "Lower forward panel"
/// (warnings WARN_*, panel EFIS_*, Mode Control Panel MCP_*, panel principal
/// MAIN_*, HGS_* y las perillas de brillo LTS_*BrtKnob), incluyendo TODOS los
/// campos intermedios aunque no se expongan como control legible (ver
/// LayoutFieldKind.UShort/Short/Float/Int, bloqueados hoy por el enum
/// nativeType de packages/profile-schema/control.schema.json). El resto del
/// struct (desde GPWS_annunINOP en adelante, ver línea ~432) NO está
/// transcrito todavía. Agregar un campo nuevo requiere:
///   1. Ubicarlo en PMDG_NG3_SDK.h y confirmar su posición exacta en la
///      declaración de PMDG_NG3_Data (el orden del struct importa: el offset de
///      cada campo depende de la suma acumulada de todos los campos anteriores).
///   2. Agregar TODOS los campos intermedios no transcritos aún entre el último
///      campo de esta tabla y el campo nuevo (aunque no se vayan a exponer como
///      control legible), para que el cálculo acumulado de offsets siga siendo
///      correcto.
///   3. Confirmar contra una sesión real de MSFS + PMDG 737 (ver
///      PmdgClientDataClient.cs, sección "NO VERIFICADO").
///
/// Esta tabla NUNCA fue ejecutada contra el SDK real ni contra MSFS -- ver nota
/// de verificación en PmdgClientDataClient.cs.
/// </summary>
internal static class PmdgNg3DataLayout
{
    /// <summary>Tipo nativo interno usado solo para calcular tamaño/alineación (incluye tipos que el
    /// esquema de perfiles todavía no expone como nativeType legible, ej. float/int, que existen en el
    /// struct real y deben contarse para que el offset de los campos siguientes sea correcto).</summary>
    public enum LayoutFieldKind
    {
        Bool,
        UChar,
        UInt,
        Int,
        Float,
        Char,
        /// <summary>unsigned short (2 bytes) -- ej. MCP_Course/MCP_Heading/MCP_Altitude. NO existe
        /// como nativeType en packages/profile-schema/control.schema.json todavía (el enum solo
        /// admite bool/uchar/uint/char_array/float/int) -- se modela aquí SOLO para que el offset
        /// acumulado de los campos siguientes sea correcto; exponerlo como control real requiere
        /// ampliar el esquema, coordinar con el orchestrator.</summary>
        UShort,
        /// <summary>short con signo (2 bytes) -- ej. MCP_VertSpeed. Mismo bloqueo que UShort: sin
        /// nativeType equivalente en el esquema hoy.</summary>
        Short,
    }

    public sealed record FieldDescriptor(string Name, LayoutFieldKind Kind, int ArrayLength = 1)
    {
        public int ElementSize => Kind switch
        {
            LayoutFieldKind.Bool => 1,
            LayoutFieldKind.UChar => 1,
            LayoutFieldKind.Char => 1,
            LayoutFieldKind.UInt => 4,
            LayoutFieldKind.Int => 4,
            LayoutFieldKind.Float => 4,
            LayoutFieldKind.UShort => 2,
            LayoutFieldKind.Short => 2,
            _ => throw new NotSupportedException(Kind.ToString()),
        };

        public int Alignment => ElementSize; // Coincide con la alineación natural de estos tipos en MSVC.
        public int TotalSize => ElementSize * ArrayLength;
    }

    /// <summary>
    /// Orden EXACTO de campos de PMDG_NG3_Data desde el inicio del struct hasta
    /// "LTS_WheelWellSw" (ver comentario de clase). El orden importa: no reordenar.
    /// </summary>
    private static readonly FieldDescriptor[] OrderedFields =
    {
        new("IRS_DisplaySelector", LayoutFieldKind.UChar),
        new("IRS_SysDisplay_R", LayoutFieldKind.Bool),
        new("IRS_annunGPS", LayoutFieldKind.Bool),
        new("IRS_annunALIGN", LayoutFieldKind.Bool, 2),
        new("IRS_annunON_DC", LayoutFieldKind.Bool, 2),
        new("IRS_annunFAULT", LayoutFieldKind.Bool, 2),
        new("IRS_annunDC_FAIL", LayoutFieldKind.Bool, 2),
        new("IRS_ModeSelector", LayoutFieldKind.UChar, 2),
        new("IRS_aligned", LayoutFieldKind.Bool),
        new("IRS_DisplayLeft", LayoutFieldKind.Char, 7),
        new("IRS_DisplayRight", LayoutFieldKind.Char, 8),
        new("IRS_DisplayShowsDots", LayoutFieldKind.Bool),
        new("AFS_AutothrottleServosConnected", LayoutFieldKind.Bool),
        new("AFS_ControlsPitch", LayoutFieldKind.Bool),
        new("AFS_ControlsRoll", LayoutFieldKind.Bool),
        new("WARN_annunPSEU", LayoutFieldKind.Bool),
        new("COMM_ServiceInterphoneSw", LayoutFieldKind.Bool),
        new("LTS_DomeWhiteSw", LayoutFieldKind.UChar),
        new("ENG_EECSwitch", LayoutFieldKind.Bool, 2),
        new("ENG_annunREVERSER", LayoutFieldKind.Bool, 2),
        new("ENG_annunENGINE_CONTROL", LayoutFieldKind.Bool, 2),
        new("ENG_annunALTN", LayoutFieldKind.Bool, 2),
        new("ENG_StartValve", LayoutFieldKind.Bool, 2),
        new("OXY_Needle", LayoutFieldKind.UChar),
        new("OXY_SwNormal", LayoutFieldKind.Bool),
        new("OXY_annunPASS_OXY_ON", LayoutFieldKind.Bool),
        new("GEAR_annunOvhdLEFT", LayoutFieldKind.Bool),
        new("GEAR_annunOvhdNOSE", LayoutFieldKind.Bool),
        new("GEAR_annunOvhdRIGHT", LayoutFieldKind.Bool),
        new("FLTREC_SwNormal", LayoutFieldKind.Bool),
        new("FLTREC_annunOFF", LayoutFieldKind.Bool),
        new("CVR_annunTEST", LayoutFieldKind.Bool),
        new("FCTL_FltControl_Sw", LayoutFieldKind.UChar, 2),
        new("FCTL_Spoiler_Sw", LayoutFieldKind.Bool, 2),
        new("FCTL_YawDamper_Sw", LayoutFieldKind.Bool),
        new("FCTL_AltnFlaps_Sw_ARM", LayoutFieldKind.Bool),
        new("FCTL_AltnFlaps_Control_Sw", LayoutFieldKind.UChar),
        new("FCTL_annunFC_LOW_PRESSURE", LayoutFieldKind.Bool, 2),
        new("FCTL_annunYAW_DAMPER", LayoutFieldKind.Bool),
        new("FCTL_annunLOW_QUANTITY", LayoutFieldKind.Bool),
        new("FCTL_annunLOW_PRESSURE", LayoutFieldKind.Bool),
        new("FCTL_annunLOW_STBY_RUD_ON", LayoutFieldKind.Bool),
        new("FCTL_annunFEEL_DIFF_PRESS", LayoutFieldKind.Bool),
        new("FCTL_annunSPEED_TRIM_FAIL", LayoutFieldKind.Bool),
        new("FCTL_annunMACH_TRIM_FAIL", LayoutFieldKind.Bool),
        new("FCTL_annunAUTO_SLAT_FAIL", LayoutFieldKind.Bool),
        new("NAVDIS_VHFNavSelector", LayoutFieldKind.UChar),
        new("NAVDIS_IRSSelector", LayoutFieldKind.UChar),
        new("NAVDIS_FMCSelector", LayoutFieldKind.UChar),
        new("NAVDIS_SourceSelector", LayoutFieldKind.UChar),
        new("NAVDIS_ControlPaneSelector", LayoutFieldKind.UChar),
        new("ADF_StandbyFrequency", LayoutFieldKind.UInt),
        new("FUEL_FuelTempNeedle", LayoutFieldKind.Float),
        new("FUEL_CrossFeedSw", LayoutFieldKind.Bool),
        new("FUEL_PumpFwdSw", LayoutFieldKind.Bool, 2),
        new("FUEL_PumpAftSw", LayoutFieldKind.Bool, 2),
        new("FUEL_PumpCtrSw", LayoutFieldKind.Bool, 2),
        new("FUEL_AuxFwd", LayoutFieldKind.Bool, 2),
        new("FUEL_AuxAft", LayoutFieldKind.Bool, 2),
        new("FUEL_FWDBleed", LayoutFieldKind.Bool),
        new("FUEL_AFTBleed", LayoutFieldKind.Bool),
        new("FUEL_GNDXfr", LayoutFieldKind.Bool),
        new("FUEL_annunENG_VALVE_CLOSED", LayoutFieldKind.UChar, 2),
        new("FUEL_annunSPAR_VALVE_CLOSED", LayoutFieldKind.UChar, 2),
        new("FUEL_annunFILTER_BYPASS", LayoutFieldKind.Bool, 2),
        new("FUEL_annunXFEED_VALVE_OPEN", LayoutFieldKind.UChar),
        new("FUEL_annunLOWPRESS_Fwd", LayoutFieldKind.Bool, 2),
        new("FUEL_annunLOWPRESS_Aft", LayoutFieldKind.Bool, 2),
        new("FUEL_annunLOWPRESS_Ctr", LayoutFieldKind.Bool, 2),
        new("FUEL_QtyCenter", LayoutFieldKind.Float),
        new("FUEL_QtyLeft", LayoutFieldKind.Float),
        new("FUEL_QtyRight", LayoutFieldKind.Float),
        new("ELEC_annunBAT_DISCHARGE", LayoutFieldKind.Bool),
        new("ELEC_annunTR_UNIT", LayoutFieldKind.Bool),
        new("ELEC_annunELEC", LayoutFieldKind.Bool),
        new("ELEC_DCMeterSelector", LayoutFieldKind.UChar),
        new("ELEC_ACMeterSelector", LayoutFieldKind.UChar),
        new("ELEC_BatSelector", LayoutFieldKind.UChar),
        new("ELEC_CabUtilSw", LayoutFieldKind.Bool),
        new("ELEC_IFEPassSeatSw", LayoutFieldKind.Bool),
        new("ELEC_annunDRIVE", LayoutFieldKind.Bool, 2),
        new("ELEC_annunSTANDBY_POWER_OFF", LayoutFieldKind.Bool),
        new("ELEC_IDGDisconnectSw", LayoutFieldKind.Bool, 2),
        new("ELEC_StandbyPowerSelector", LayoutFieldKind.UChar),
        new("ELEC_annunGRD_POWER_AVAILABLE", LayoutFieldKind.Bool),
        new("ELEC_GrdPwrSw", LayoutFieldKind.Bool),
        new("ELEC_BusTransSw_AUTO", LayoutFieldKind.Bool),
        new("ELEC_GenSw", LayoutFieldKind.Bool, 2),
        new("ELEC_APUGenSw", LayoutFieldKind.Bool, 2),
        new("ELEC_annunTRANSFER_BUS_OFF", LayoutFieldKind.Bool, 2),
        new("ELEC_annunSOURCE_OFF", LayoutFieldKind.Bool, 2),
        new("ELEC_annunGEN_BUS_OFF", LayoutFieldKind.Bool, 2),
        new("ELEC_annunAPU_GEN_OFF_BUS", LayoutFieldKind.Bool),
        new("ELEC_MeterDisplayTop", LayoutFieldKind.Char, 13),
        new("ELEC_MeterDisplayBottom", LayoutFieldKind.Char, 13),
        new("ELEC_BusPowered", LayoutFieldKind.Bool, 16),
        new("APU_EGTNeedle", LayoutFieldKind.Float),
        new("APU_annunMAINT", LayoutFieldKind.Bool),
        new("APU_annunLOW_OIL_PRESSURE", LayoutFieldKind.Bool),
        new("APU_annunFAULT", LayoutFieldKind.Bool),
        new("APU_annunOVERSPEED", LayoutFieldKind.Bool),
        new("OH_WiperLSelector", LayoutFieldKind.UChar),
        new("OH_WiperRSelector", LayoutFieldKind.UChar),
        new("LTS_CircuitBreakerKnob", LayoutFieldKind.UChar),
        new("LTS_OvereadPanelKnob", LayoutFieldKind.UChar),
        new("AIR_EquipCoolingSupplyNORM", LayoutFieldKind.Bool),
        new("AIR_EquipCoolingExhaustNORM", LayoutFieldKind.Bool),
        new("AIR_annunEquipCoolingSupplyOFF", LayoutFieldKind.Bool),
        new("AIR_annunEquipCoolingExhaustOFF", LayoutFieldKind.Bool),
        new("LTS_annunEmerNOT_ARMED", LayoutFieldKind.Bool),
        new("LTS_EmerExitSelector", LayoutFieldKind.UChar),
        new("COMM_NoSmokingSelector", LayoutFieldKind.UChar),
        new("COMM_FastenBeltsSelector", LayoutFieldKind.UChar),
        new("COMM_annunCALL", LayoutFieldKind.Bool),
        new("COMM_annunPA_IN_USE", LayoutFieldKind.Bool),
        new("ICE_annunOVERHEAT", LayoutFieldKind.Bool, 4),
        new("ICE_annunON", LayoutFieldKind.Bool, 4),
        new("ICE_WindowHeatSw", LayoutFieldKind.Bool, 4),
        new("ICE_annunCAPT_PITOT", LayoutFieldKind.Bool),
        new("ICE_annunL_ELEV_PITOT", LayoutFieldKind.Bool),
        new("ICE_annunL_ALPHA_VANE", LayoutFieldKind.Bool),
        new("ICE_annunL_TEMP_PROBE", LayoutFieldKind.Bool),
        new("ICE_annunFO_PITOT", LayoutFieldKind.Bool),
        new("ICE_annunR_ELEV_PITOT", LayoutFieldKind.Bool),
        new("ICE_annunR_ALPHA_VANE", LayoutFieldKind.Bool),
        new("ICE_annunAUX_PITOT", LayoutFieldKind.Bool),
        new("ICE_ProbeHeatSw", LayoutFieldKind.Bool, 2),
        new("ICE_annunVALVE_OPEN", LayoutFieldKind.Bool, 2),
        new("ICE_annunCOWL_ANTI_ICE", LayoutFieldKind.Bool, 2),
        new("ICE_annunCOWL_VALVE_OPEN", LayoutFieldKind.Bool, 2),
        new("ICE_WingAntiIceSw", LayoutFieldKind.Bool),
        new("ICE_EngAntiIceSw", LayoutFieldKind.Bool, 2),
        new("ICE_WindowHeatTestSw", LayoutFieldKind.Int),
        new("HYD_annunLOW_PRESS_eng", LayoutFieldKind.Bool, 2),
        new("HYD_annunLOW_PRESS_elec", LayoutFieldKind.Bool, 2),
        new("HYD_annunOVERHEAT_elec", LayoutFieldKind.Bool, 2),
        new("HYD_PumpSw_eng", LayoutFieldKind.Bool, 2),
        new("HYD_PumpSw_elec", LayoutFieldKind.Bool, 2),
        new("AIR_TempSourceSelector", LayoutFieldKind.UChar),
        new("AIR_TrimAirSwitch", LayoutFieldKind.Bool),
        new("AIR_annunZoneTemp", LayoutFieldKind.Bool, 3),
        new("AIR_annunDualBleed", LayoutFieldKind.Bool),
        new("AIR_annunRamDoorL", LayoutFieldKind.Bool),
        new("AIR_annunRamDoorR", LayoutFieldKind.Bool),
        new("AIR_RecircFanSwitch", LayoutFieldKind.Bool, 2),
        new("AIR_PackSwitch", LayoutFieldKind.UChar, 2),
        new("AIR_BleedAirSwitch", LayoutFieldKind.Bool, 2),
        new("AIR_APUBleedAirSwitch", LayoutFieldKind.Bool),
        new("AIR_IsolationValveSwitch", LayoutFieldKind.UChar),
        new("AIR_annunPackTripOff", LayoutFieldKind.Bool, 2),
        new("AIR_annunWingBodyOverheat", LayoutFieldKind.Bool, 2),
        new("AIR_annunBleedTripOff", LayoutFieldKind.Bool, 2),
        new("AIR_annunAUTO_FAIL", LayoutFieldKind.Bool),
        new("AIR_annunOFFSCHED_DESCENT", LayoutFieldKind.Bool),
        new("AIR_annunALTN", LayoutFieldKind.Bool),
        new("AIR_annunMANUAL", LayoutFieldKind.Bool),
        new("AIR_DuctPress", LayoutFieldKind.Float, 2),
        new("AIR_DuctPressNeedle", LayoutFieldKind.Float, 2),
        new("AIR_CabinAltNeedle", LayoutFieldKind.Float),
        new("AIR_CabinDPNeedle", LayoutFieldKind.Float),
        new("AIR_CabinVSNeedle", LayoutFieldKind.Float),
        new("AIR_CabinValveNeedle", LayoutFieldKind.Float),
        new("AIR_TemperatureNeedle", LayoutFieldKind.Float),
        new("AIR_DisplayFltAlt", LayoutFieldKind.Char, 6),
        new("AIR_DisplayLandAlt", LayoutFieldKind.Char, 6),
        new("DOOR_annunFWD_ENTRY", LayoutFieldKind.Bool),
        new("DOOR_annunFWD_SERVICE", LayoutFieldKind.Bool),
        new("DOOR_annunAIRSTAIR", LayoutFieldKind.Bool),
        new("DOOR_annunLEFT_FWD_OVERWING", LayoutFieldKind.Bool),
        new("DOOR_annunRIGHT_FWD_OVERWING", LayoutFieldKind.Bool),
        new("DOOR_annunFWD_CARGO", LayoutFieldKind.Bool),
        new("DOOR_annunEQUIP", LayoutFieldKind.Bool),
        new("DOOR_annunLEFT_AFT_OVERWING", LayoutFieldKind.Bool),
        new("DOOR_annunRIGHT_AFT_OVERWING", LayoutFieldKind.Bool),
        new("DOOR_annunAFT_CARGO", LayoutFieldKind.Bool),
        new("DOOR_annunAFT_ENTRY", LayoutFieldKind.Bool),
        new("DOOR_annunAFT_SERVICE", LayoutFieldKind.Bool),
        new("AIR_FltAltWindow", LayoutFieldKind.UInt),
        new("AIR_LandAltWindow", LayoutFieldKind.UInt),
        new("AIR_OutflowValveSwitch", LayoutFieldKind.UInt),
        new("AIR_PressurizationModeSelector", LayoutFieldKind.UInt),
        new("LTS_LandingLtRetractableSw", LayoutFieldKind.UChar, 2),
        new("LTS_LandingLtFixedSw", LayoutFieldKind.Bool, 2),
        new("LTS_RunwayTurnoffSw", LayoutFieldKind.Bool, 2),
        new("LTS_TaxiSw", LayoutFieldKind.Bool),
        new("APU_Selector", LayoutFieldKind.UChar),
        new("ENG_StartSelector", LayoutFieldKind.UChar, 2),
        new("ENG_IgnitionSelector", LayoutFieldKind.UChar),
        new("LTS_LogoSw", LayoutFieldKind.Bool),
        new("LTS_PositionSw", LayoutFieldKind.UChar),
        new("LTS_AntiCollisionSw", LayoutFieldKind.Bool),
        new("LTS_WingSw", LayoutFieldKind.Bool),
        new("LTS_WheelWellSw", LayoutFieldKind.Bool),

        // --- Sección "Glareshield" en adelante (PMDG_NG3_SDK.h línea ~310). ---

        // Warnings
        new("WARN_annunFIRE_WARN", LayoutFieldKind.Bool, 2),
        new("WARN_annunMASTER_CAUTION", LayoutFieldKind.Bool, 2),
        new("WARN_annunFLT_CONT", LayoutFieldKind.Bool),
        new("WARN_annunIRS", LayoutFieldKind.Bool),
        new("WARN_annunFUEL", LayoutFieldKind.Bool),
        new("WARN_annunELEC", LayoutFieldKind.Bool),
        new("WARN_annunAPU", LayoutFieldKind.Bool),
        new("WARN_annunOVHT_DET", LayoutFieldKind.Bool),
        new("WARN_annunANTI_ICE", LayoutFieldKind.Bool),
        new("WARN_annunHYD", LayoutFieldKind.Bool),
        new("WARN_annunDOORS", LayoutFieldKind.Bool),
        new("WARN_annunENG", LayoutFieldKind.Bool),
        new("WARN_annunOVERHEAD", LayoutFieldKind.Bool),
        new("WARN_annunAIR_COND", LayoutFieldKind.Bool),

        // EFIS control panels (línea 329-335)
        new("EFIS_MinsSelBARO", LayoutFieldKind.Bool, 2),
        new("EFIS_BaroSelHPA", LayoutFieldKind.Bool, 2),
        new("EFIS_VORADFSel1", LayoutFieldKind.UChar, 2),
        new("EFIS_VORADFSel2", LayoutFieldKind.UChar, 2),
        new("EFIS_ModeSel", LayoutFieldKind.UChar, 2),
        new("EFIS_RangeSel", LayoutFieldKind.UChar, 2),

        // Mode control panel (línea 337-370)
        new("MCP_Course", LayoutFieldKind.UShort, 2),
        new("MCP_IASMach", LayoutFieldKind.Float),
        new("MCP_IASBlank", LayoutFieldKind.Bool),
        new("MCP_IASOverspeedFlash", LayoutFieldKind.Bool),
        new("MCP_IASUnderspeedFlash", LayoutFieldKind.Bool),
        new("MCP_Heading", LayoutFieldKind.UShort),
        new("MCP_Altitude", LayoutFieldKind.UShort),
        new("MCP_VertSpeed", LayoutFieldKind.Short),
        new("MCP_VertSpeedBlank", LayoutFieldKind.Bool),

        new("MCP_FDSw", LayoutFieldKind.Bool, 2),
        new("MCP_ATArmSw", LayoutFieldKind.Bool),
        new("MCP_BankLimitSel", LayoutFieldKind.UChar),
        new("MCP_DisengageBar", LayoutFieldKind.Bool),

        new("MCP_annunFD", LayoutFieldKind.Bool, 2),
        new("MCP_annunATArm", LayoutFieldKind.Bool),
        new("MCP_annunN1", LayoutFieldKind.Bool),
        new("MCP_annunSPEED", LayoutFieldKind.Bool),
        new("MCP_annunVNAV", LayoutFieldKind.Bool),
        new("MCP_annunLVL_CHG", LayoutFieldKind.Bool),
        new("MCP_annunHDG_SEL", LayoutFieldKind.Bool),
        new("MCP_annunLNAV", LayoutFieldKind.Bool),
        new("MCP_annunVOR_LOC", LayoutFieldKind.Bool),
        new("MCP_annunAPP", LayoutFieldKind.Bool),
        new("MCP_annunALT_HOLD", LayoutFieldKind.Bool),
        new("MCP_annunVS", LayoutFieldKind.Bool),
        new("MCP_annunCMD_A", LayoutFieldKind.Bool),
        new("MCP_annunCWS_A", LayoutFieldKind.Bool),
        new("MCP_annunCMD_B", LayoutFieldKind.Bool),
        new("MCP_annunCWS_B", LayoutFieldKind.Bool),

        new("MCP_indication_powered", LayoutFieldKind.Bool),

        // Forward panel (línea 373-405)
        new("MAIN_NoseWheelSteeringSwNORM", LayoutFieldKind.Bool),
        new("MAIN_annunBELOW_GS", LayoutFieldKind.Bool, 2),
        new("MAIN_MainPanelDUSel", LayoutFieldKind.UChar, 2),
        new("MAIN_LowerDUSel", LayoutFieldKind.UChar, 2),
        new("MAIN_annunAP", LayoutFieldKind.Bool, 2),
        new("MAIN_annunAP_Amber", LayoutFieldKind.Bool, 2),
        new("MAIN_annunAT", LayoutFieldKind.Bool, 2),
        new("MAIN_annunAT_Amber", LayoutFieldKind.Bool, 2),
        new("MAIN_annunFMC", LayoutFieldKind.Bool, 2),
        new("MAIN_DisengageTestSelector", LayoutFieldKind.UChar, 2),
        new("MAIN_annunSPEEDBRAKE_ARMED", LayoutFieldKind.Bool),
        new("MAIN_annunSPEEDBRAKE_DO_NOT_ARM", LayoutFieldKind.Bool),
        new("MAIN_annunSPEEDBRAKE_EXTENDED", LayoutFieldKind.Bool),
        new("MAIN_annunSTAB_OUT_OF_TRIM", LayoutFieldKind.Bool),
        new("MAIN_LightsSelector", LayoutFieldKind.UChar),
        new("MAIN_RMISelector1_VOR", LayoutFieldKind.Bool),
        new("MAIN_RMISelector2_VOR", LayoutFieldKind.Bool),
        new("MAIN_N1SetSelector", LayoutFieldKind.UChar),
        new("MAIN_SpdRefSelector", LayoutFieldKind.UChar),
        new("MAIN_FuelFlowSelector", LayoutFieldKind.UChar),
        new("MAIN_AutobrakeSelector", LayoutFieldKind.UChar),
        new("MAIN_annunANTI_SKID_INOP", LayoutFieldKind.Bool),
        new("MAIN_annunAUTO_BRAKE_DISARM", LayoutFieldKind.Bool),
        new("MAIN_annunLE_FLAPS_TRANSIT", LayoutFieldKind.Bool),
        new("MAIN_annunLE_FLAPS_EXT", LayoutFieldKind.Bool),
        new("MAIN_TEFlapsNeedle", LayoutFieldKind.Float, 2),
        new("MAIN_annunGEAR_transit", LayoutFieldKind.Bool, 3),
        new("MAIN_annunGEAR_locked", LayoutFieldKind.Bool, 3),
        new("MAIN_GearLever", LayoutFieldKind.UChar),
        new("MAIN_BrakePressNeedle", LayoutFieldKind.Float),
        new("MAIN_annunCABIN_ALTITUDE", LayoutFieldKind.Bool),
        new("MAIN_annunTAKEOFF_CONFIG", LayoutFieldKind.Bool),

        // HGS (línea 407-418)
        new("HGS_annun_AIII", LayoutFieldKind.Bool),
        new("HGS_annun_NO_AIII", LayoutFieldKind.Bool),
        new("HGS_annun_FLARE", LayoutFieldKind.Bool),
        new("HGS_annun_RO", LayoutFieldKind.Bool),
        new("HGS_annun_RO_CTN", LayoutFieldKind.Bool),
        new("HGS_annun_RO_ARM", LayoutFieldKind.Bool),
        new("HGS_annun_TO", LayoutFieldKind.Bool),
        new("HGS_annun_TO_CTN", LayoutFieldKind.Bool),
        new("HGS_annun_APCH", LayoutFieldKind.Bool),
        new("HGS_annun_TO_WARN", LayoutFieldKind.Bool),
        new("HGS_annun_Bar", LayoutFieldKind.Bool),
        new("HGS_annun_FAIL", LayoutFieldKind.Bool),

        // Lower forward panel (línea 420-430)
        new("LTS_MainPanelKnob", LayoutFieldKind.UChar, 2),
        new("LTS_BackgroundKnob", LayoutFieldKind.UChar),
        new("LTS_AFDSFloodKnob", LayoutFieldKind.UChar),
        new("LTS_OutbdDUBrtKnob", LayoutFieldKind.UChar, 2),
        new("LTS_InbdDUBrtKnob", LayoutFieldKind.UChar, 2),
        new("LTS_InbdDUMapBrtKnob", LayoutFieldKind.UChar, 2),
        new("LTS_UpperDUBrtKnob", LayoutFieldKind.UChar),
        new("LTS_LowerDUBrtKnob", LayoutFieldKind.UChar),
        new("LTS_LowerDUMapBrtKnob", LayoutFieldKind.UChar),

        // --- Fin del tramo transcrito (LTS_LowerDUMapBrtKnob, línea 430). Resto
        // de PMDG_NG3_Data (desde GPWS_annunINOP en adelante, línea ~432) NO
        // está mapeado -- ver comentario de clase. ---
    };

    private static readonly Dictionary<string, (int Offset, FieldDescriptor Field)> ByName = BuildOffsets();

    private static Dictionary<string, (int, FieldDescriptor)> BuildOffsets()
    {
        var result = new Dictionary<string, (int, FieldDescriptor)>(StringComparer.Ordinal);
        var cursor = 0;
        foreach (var field in OrderedFields)
        {
            var alignment = field.Alignment;
            if (alignment > 1 && cursor % alignment != 0)
            {
                cursor += alignment - (cursor % alignment); // padding de alineación, igual que MSVC.
            }

            result[field.Name] = (cursor, field);
            cursor += field.TotalSize;
        }

        return result;
    }

    /// <summary>
    /// Offset en bytes de <paramref name="fieldName"/> dentro de PMDG_NG3_Data, o null si
    /// el campo no está transcrito todavía en esta tabla (ver comentario de clase).
    /// </summary>
    public static bool TryGetField(string fieldName, out int offset, out FieldDescriptor field)
    {
        if (ByName.TryGetValue(fieldName, out var entry))
        {
            offset = entry.Item1;
            field = entry.Item2;
            return true;
        }

        offset = 0;
        field = null!;
        return false;
    }
}
