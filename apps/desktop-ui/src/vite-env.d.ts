/// <reference types="vite/client" />

interface WeConnectSetupConfig {
  firstLaunchCompleted: boolean;
  communityPath: string | null;
  /** package_version del paquete que se copió a Community la última vez. Permite
   * reemplazarlo en silencio cuando la app trae uno más nuevo. */
  installedPackageVersion?: string | null;
}

interface WeConnectInstallResult {
  ok: boolean;
  error?: string;
  version?: string | null;
}

/** Estado de FSUIPC7, el requisito real para que el iFly/PMDG sincronicen algo. */
interface WeConnectFsuipcStatus {
  installed: boolean;
  path: string | null;
  /** FSUIPC_WAPID.dll presente: sin él FSUIPC7 corre pero no expone L-Vars. */
  wapiPresent: boolean;
}

interface Window {
  weconnectDesktop?: {
    openInstallFolder: () => Promise<string>;
    openExternal: (url: string) => Promise<boolean>;
    restartApp: () => Promise<void>;
  };
  weconnectDirectRelay?: {
    ensureHost: () => Promise<{
      ok: boolean;
      baseUrl?: string;
      error?: string;
      /** IP de esta PC en la LAN: sirve al invitado de la misma red. */
      lanIp?: string | null;
      /** IP publica: la que necesita un invitado que no esta en tu red. */
      publicIp?: string | null;
      /** ¿El router abrio el puerto solo (UPnP)? */
      portMapped?: boolean;
      /** Por que no se pudo abrir, para poder explicarlo. */
      portMapError?: string | null;
    }>;
  };
  weconnectNetwork?: {
    getLocalAddresses: () => Promise<{ ipv4: string | null; ipv6: string | null }>;
  };
  weconnectWindow?: {
    isElectron: true;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onStateChange: (callback: (payload: { maximized: boolean }) => void) => () => void;
  };
  weconnectSetup?: {
    getConfig: () => Promise<WeConnectSetupConfig>;
    chooseFolder: () => Promise<string | null>;
    validateFolder: (folderPath: string) => Promise<WeConnectInstallResult>;
    installPackages: (folderPath: string) => Promise<WeConnectInstallResult>;
    markCompleted: (communityPath: string) => Promise<WeConnectSetupConfig>;
    reset: () => Promise<WeConnectSetupConfig>;
    checkFsuipc: () => Promise<WeConnectFsuipcStatus>;
  };
}
