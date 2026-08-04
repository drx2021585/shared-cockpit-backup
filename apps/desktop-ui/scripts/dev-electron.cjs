const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEV_SERVER_URL = process.env.ELECTRON_START_URL || "http://localhost:5173";
const timeoutMs = 30_000;
const pollMs = 250;

function waitForPort(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    function tryConnect() {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeout) {
          reject(new Error(`Timed out waiting for dev server at ${host}:${port}. Start it with "npm run dev:web".`));
          return;
        }
        setTimeout(tryConnect, pollMs);
      });
    }

    tryConnect();
  });
}

async function main() {
  const url = new URL(DEV_SERVER_URL);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  await waitForPort(url.hostname, port, timeoutMs);

  const electronBinary = require("electron");
  const child = spawn(electronBinary, ["."], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_START_URL: DEV_SERVER_URL,
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
