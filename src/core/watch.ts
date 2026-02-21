import { watch as chokidarWatch } from "chokidar";
import { getConfigPath } from "./config.js";
import { sync } from "./sync.js";

export function watchConfig(options?: {
  onSync?: (result: Awaited<ReturnType<typeof sync>>) => void;
  onError?: (error: Error) => void;
  debounceMs?: number;
}): { close: () => Promise<void> } {
  const configPath = getConfigPath();
  const debounceMs = options?.debounceMs ?? 500;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;

  const doSync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const result = await sync();
      options?.onSync?.(result);
    } catch (err: unknown) {
      options?.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      syncing = false;
    }
  };

  const watcher = chokidarWatch(configPath, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("change", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSync, debounceMs);
  });

  return {
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      await watcher.close();
    },
  };
}
