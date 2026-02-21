import { readConfig, type Config } from "./config.js";
import { getTunnelStatus, startTunnel, stopTunnel, cleanStalePid, type TunnelStatus } from "./tunnel.js";

export interface SyncResult {
  started: string[];
  stopped: string[];
  alreadyRunning: string[];
  alreadyStopped: string[];
  errors: { id: string; error: string }[];
}

export async function sync(config?: Config): Promise<SyncResult> {
  const cfg = config ?? await readConfig();
  const result: SyncResult = {
    started: [],
    stopped: [],
    alreadyRunning: [],
    alreadyStopped: [],
    errors: [],
  };

  for (const tunnel of cfg.tunnels) {
    try {
      await cleanStalePid(tunnel.id);
      const status = await getTunnelStatus(tunnel);

      if (tunnel.enabled) {
        if (status.alive && status.portOpen) {
          result.alreadyRunning.push(tunnel.id);
        } else {
          // Stop any zombie process first
          if (status.alive && !status.portOpen) {
            await stopTunnel(tunnel.id);
          }
          await startTunnel(tunnel);
          result.started.push(tunnel.id);
        }
      } else {
        if (status.alive) {
          await stopTunnel(tunnel.id);
          result.stopped.push(tunnel.id);
        } else {
          result.alreadyStopped.push(tunnel.id);
        }
      }
    } catch (err: unknown) {
      result.errors.push({
        id: tunnel.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export async function getStatus(config?: Config): Promise<TunnelStatus[]> {
  const cfg = config ?? await readConfig();
  const statuses: TunnelStatus[] = [];

  for (const tunnel of cfg.tunnels) {
    await cleanStalePid(tunnel.id);
    statuses.push(await getTunnelStatus(tunnel));
  }

  return statuses;
}
