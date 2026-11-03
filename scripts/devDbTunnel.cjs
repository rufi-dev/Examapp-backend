/*
 * Local development only (`npm run backend`). The database lives on the server
 * (self-hosted Mongo since 2026-09-16) and listens on the server's loopback only,
 * closed to the internet. This opens an SSH tunnel to it before the backend
 * starts, so a local MONGO_URI of 127.0.0.1:<DEV_DB_TUNNEL_PORT> reaches it:
 *
 *   DEV_DB_TUNNEL=root@91.99.147.241   (unset: nothing happens, e.g. on the server)
 *   DEV_DB_TUNNEL_PORT=27019
 *
 * The tunnel keeps running in the background after this exits, so nodemon's
 * restarts reuse it. It needs the SSH key in the Windows ssh-agent (ssh-add).
 */
require("dotenv").config();
const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");

const target = String(process.env.DEV_DB_TUNNEL || "").trim();
if (!target) process.exit(0);
const port = Number(process.env.DEV_DB_TUNNEL_PORT) || 27019;

const isOpen = () =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (await isOpen()) {
    console.log(`[db-tunnel] open on 127.0.0.1:${port}`);
    return;
  }
  // Windows' own ssh uses the Windows ssh-agent that holds the key; Git's ssh does not.
  const windowsSsh = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
  const ssh = process.platform === "win32" && fs.existsSync(windowsSsh) ? windowsSsh : "ssh";
  const child = spawn(
    ssh,
    ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", `${port}:127.0.0.1:27017`, target],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  let exited = null;
  child.on("exit", (code) => {
    exited = code;
  });
  child.unref();
  for (let i = 0; i < 40 && exited === null; i += 1) {
    await wait(500);
    if (await isOpen()) {
      console.log(`[db-tunnel] opened 127.0.0.1:${port} -> ${target} (database on the server)`);
      return;
    }
  }
  console.error(
    `[db-tunnel] could not open the tunnel to ${target}${exited !== null ? ` (ssh exited with ${exited})` : ""}.\n` +
      "  Is the SSH key loaded? In PowerShell: ssh-add C:\\Users\\rufia\\Desktop\\ExamopiaSSH"
  );
  process.exit(1);
})();
