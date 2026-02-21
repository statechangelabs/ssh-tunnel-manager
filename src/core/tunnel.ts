import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { getPidsDir, getHistoryDir, type TunnelConfig } from "./config.js";

export interface TunnelStatus {
  id: string;
  name: string;
  enabled: boolean;
  pid: number | null;
  alive: boolean;
  portOpen: boolean;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  host: string;
}

function pidFilePath(id: string): string {
  return join(getPidsDir(), `${id}.pid`);
}

function logFilePath(id: string): string {
  return join(getHistoryDir(), `${id}.log`);
}

export function getLogFilePath(id: string): string {
  return logFilePath(id);
}

async function readPid(id: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFilePath(id), "utf-8");
    const pid = parseInt(raw.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probePort(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function getTunnelStatus(tunnel: TunnelConfig): Promise<TunnelStatus> {
  const pid = await readPid(tunnel.id);
  const alive = pid !== null && isProcessAlive(pid);
  const portOpen = alive ? await probePort(tunnel.localPort) : false;

  return {
    id: tunnel.id,
    name: tunnel.name,
    enabled: tunnel.enabled,
    pid,
    alive,
    portOpen,
    localPort: tunnel.localPort,
    remoteHost: tunnel.remoteHost,
    remotePort: tunnel.remotePort,
    host: tunnel.host,
  };
}

export async function startTunnel(tunnel: TunnelConfig): Promise<number> {
  const args: string[] = [
    "-N", // No remote command
    "-L", `${tunnel.localPort}:${tunnel.remoteHost}:${tunnel.remotePort}`,
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=accept-new",
  ];

  if (tunnel.user) {
    args.push("-l", tunnel.user);
  }

  if (tunnel.sshPort && tunnel.sshPort !== 22) {
    args.push("-p", String(tunnel.sshPort));
  }

  if (tunnel.identityFile) {
    const expandedPath = tunnel.identityFile.replace(/^~/, process.env.HOME || "");
    args.push("-i", expandedPath);
  }

  if (tunnel.extraArgs) {
    args.push(...tunnel.extraArgs);
  }

  args.push(tunnel.host);

  const { openSync } = await import("node:fs");
  const logFd = openSync(logFilePath(tunnel.id), "a");

  const child = spawn("ssh", args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  const { closeSync } = await import("node:fs");
  closeSync(logFd);

  child.unref();

  if (child.pid === undefined) {
    throw new Error(`Failed to start tunnel ${tunnel.id}`);
  }

  await writeFile(pidFilePath(tunnel.id), String(child.pid), "utf-8");

  return child.pid;
}

export async function stopTunnel(id: string): Promise<void> {
  const pid = await readPid(id);
  if (pid === null) return;

  if (isProcessAlive(pid)) {
    const treeKill = (await import("tree-kill")).default;
    await new Promise<void>((resolve, reject) => {
      treeKill(pid, "SIGTERM", (err) => {
        if (err) {
          // Try SIGKILL as fallback
          treeKill(pid, "SIGKILL", () => resolve());
        } else {
          resolve();
        }
      });
    });
  }

  try {
    await unlink(pidFilePath(id));
  } catch {
    // PID file may already be gone
  }
}

export async function cleanStalePid(id: string): Promise<void> {
  const pid = await readPid(id);
  if (pid !== null && !isProcessAlive(pid)) {
    try {
      await unlink(pidFilePath(id));
    } catch {
      // already gone
    }
  }
}
