"use strict";

const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DASHBOARD_PORT = Number(process.env.PORT || 8099);

function start(name, cmd) {
  const child = spawn(cmd, {
    cwd: ROOT,
    shell: true,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[${name}] exited by signal ${signal}`);
    } else {
      console.log(`[${name}] exited with code ${code}`);
    }
  });

  return child;
}

let dashboard = null;
const wrapper = start("wrapper", "npm run test:wrapper");

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(600);

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });

    socket.connect(port, "127.0.0.1");
  });
}

async function startDashboardIfNeeded() {
  const running = await isPortOpen(DASHBOARD_PORT);
  if (running) {
    console.log(`[dashboard] already running on port ${DASHBOARD_PORT}, skip start`);
    return;
  }
  dashboard = start("dashboard", "npm run dashboard");
}

startDashboardIfNeeded().catch((err) => {
  console.error(`[dashboard] start check failed: ${err.message}`);
});

function shutdown() {
  if (wrapper && !wrapper.killed) {
    wrapper.kill("SIGTERM");
  }
  if (dashboard && !dashboard.killed) {
    dashboard.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
