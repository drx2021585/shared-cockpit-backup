const path = require("node:path");
const { spawn } = require("node:child_process");

const cwd = path.join(__dirname, "..");
const npmCli = process.env.npm_execpath;
const devServerUrl = "http://localhost:5173";

if (!npmCli) {
  console.error('npm_execpath is not set. Run this script through "npm run dev".');
  process.exit(1);
}

function spawnNpm(args, extraEnv = {}) {
  return spawn(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

const vite = spawnNpm(["run", "dev:web"]);

const electron = spawnNpm(["run", "dev:electron"], {
  ELECTRON_START_URL: devServerUrl,
});

vite.on("error", (error) => {
  console.error(`Could not start Vite dev server: ${error.message}`);
  shutdown(1);
});

electron.on("error", (error) => {
  console.error(`Could not start Electron dev process: ${error.message}`);
  shutdown(1);
});

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (!vite.killed) {
    vite.kill();
  }
  if (!electron.killed) {
    electron.kill();
  }

  process.exit(exitCode);
}

vite.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`Vite dev server exited unexpectedly (${code ?? 0}).`);
    shutdown(code ?? 1);
  }
});

electron.on("exit", (code) => {
  shutdown(code ?? 0);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
