import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TunnelConfig {
  id: string;
  name: string;
  host: string;
  user: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  enabled: boolean;
  identityFile?: string;
  sshPort?: number;
  extraArgs?: string[];
}

export interface Config {
  tunnels: TunnelConfig[];
}

const BASE_DIR = join(homedir(), ".ssh-tunnels");
const CONFIG_PATH = join(BASE_DIR, "config.json");
const PIDS_DIR = join(BASE_DIR, "pids");
const HISTORY_DIR = join(BASE_DIR, "history");

export function getBaseDir(): string {
  return BASE_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getPidsDir(): string {
  return PIDS_DIR;
}

export function getHistoryDir(): string {
  return HISTORY_DIR;
}

export async function ensureDirs(): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
  await mkdir(PIDS_DIR, { recursive: true });
  await mkdir(HISTORY_DIR, { recursive: true });
}

export async function readConfig(): Promise<Config> {
  await ensureDirs();
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return validateConfig(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const defaultConfig: Config = { tunnels: [] };
      await writeConfig(defaultConfig);
      return defaultConfig;
    }
    throw err;
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await ensureDirs();
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function validateConfig(data: unknown): Config {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid config: expected an object");
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.tunnels)) {
    throw new Error("Invalid config: expected tunnels array");
  }
  for (const t of obj.tunnels) {
    if (!t.id || typeof t.id !== "string") throw new Error("Invalid tunnel: missing id");
    if (!t.host || typeof t.host !== "string") throw new Error(`Invalid tunnel ${t.id}: missing host`);
    if (typeof t.localPort !== "number") throw new Error(`Invalid tunnel ${t.id}: missing localPort`);
    if (!t.remoteHost || typeof t.remoteHost !== "string") throw new Error(`Invalid tunnel ${t.id}: missing remoteHost`);
    if (typeof t.remotePort !== "number") throw new Error(`Invalid tunnel ${t.id}: missing remotePort`);
  }
  return data as Config;
}

/** Generate a URL-friendly ID from a name */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
