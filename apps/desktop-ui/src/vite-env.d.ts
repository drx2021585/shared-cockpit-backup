/// <reference types="vite/client" />

interface WeConnectSetupConfig {
  firstLaunchCompleted: boolean;
  communityPath: string | null;
}

interface WeConnectInstallResult {
  ok: boolean;
  error?: string;
}

interface Window {
  weconnectDesktop?: {
    openInstallFolder: () => Promise<string>;
    restartApp: () => Promise<void>;
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
  };
}
