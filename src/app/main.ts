import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, nativeTheme } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readConfig,
  writeConfig,
  sync,
  getStatus,
  watchConfig,
  getConfigPath,
  type TunnelConfig,
  type TunnelStatus,
  slugify,
  stopTunnel,
} from "../core/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let addWindow: BrowserWindow | null = null;
let configWatcher: ReturnType<typeof watchConfig> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

// Track current statuses for tray icon
let currentStatuses: TunnelStatus[] = [];

function buildPng(width: number, height: number, rgba: Buffer): Buffer {
  // Minimal PNG encoder for RGBA data
  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(buf: Buffer): number {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // IDAT — raw pixel rows with filter byte 0 (None) per row
  const rowSize = width * 4 + 1;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0; // filter: None
    rgba.copy(rawData, y * rowSize + 1, y * width * 4, (y + 1) * width * 4);
  }

  // Wrap in zlib deflate (store mode — no compression for simplicity)
  const blocks: Buffer[] = [];
  const maxBlock = 65535;
  for (let offset = 0; offset < rawData.length; offset += maxBlock) {
    const end = Math.min(offset + maxBlock, rawData.length);
    const isLast = end === rawData.length;
    const blockData = rawData.subarray(offset, end);
    const header = Buffer.alloc(5);
    header[0] = isLast ? 1 : 0;
    header.writeUInt16LE(blockData.length, 1);
    header.writeUInt16LE(~blockData.length & 0xffff, 3);
    blocks.push(header, blockData);
  }
  const deflateData = Buffer.concat(blocks);
  const zlibHeader = Buffer.from([0x78, 0x01]); // CMF, FLG
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(rawData));
  const compressedData = Buffer.concat([zlibHeader, deflateData, adler]);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", compressedData), iend]);
}

function createTrayIcon(state: "green" | "yellow" | "red"): Electron.NativeImage {
  const size = 32;
  const colors: Record<string, [number, number, number]> = {
    green: [52, 199, 89],
    yellow: [255, 149, 0],
    red: [255, 59, 48],
  };

  const [r, g, b] = colors[state];
  const cx = size / 2;
  const cy = size / 2;
  const radius = 8;

  const rgba = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        const alpha = dist > radius - 1 ? Math.max(0, Math.round((radius - dist) * 255)) : 255;
        const offset = (y * size + x) * 4;
        rgba[offset] = r;
        rgba[offset + 1] = g;
        rgba[offset + 2] = b;
        rgba[offset + 3] = alpha;
      }
    }
  }

  const png = buildPng(size, size, rgba);
  return nativeImage.createFromBuffer(png, { scaleFactor: 2 });
}

function getTrayState(): "green" | "yellow" | "red" {
  const enabled = currentStatuses.filter((s) => s.enabled);
  if (enabled.length === 0) return "green";
  const allRunning = enabled.every((s) => s.alive && s.portOpen);
  if (allRunning) return "green";
  const anyRunning = enabled.some((s) => s.alive && s.portOpen);
  return anyRunning ? "yellow" : "red";
}

async function refreshStatuses(): Promise<void> {
  try {
    currentStatuses = await getStatus();
  } catch {
    // Config may not exist yet
    currentStatuses = [];
  }
}

async function buildTrayMenu(): Promise<Menu> {
  await refreshStatuses();

  const tunnelItems: Electron.MenuItemConstructorOptions[] = currentStatuses.map((s) => ({
    label: `${s.alive && s.portOpen ? "●" : "○"} ${s.name} — :${s.localPort} → ${s.remoteHost}:${s.remotePort}`,
    type: "checkbox" as const,
    checked: s.enabled,
    click: async () => {
      const config = await readConfig();
      const tunnel = config.tunnels.find((t) => t.id === s.id);
      if (tunnel) {
        tunnel.enabled = !tunnel.enabled;
        await writeConfig(config);
        await sync(config);
        // Wait a moment for SSH to establish connection before refreshing
        if (tunnel.enabled) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        await updateTray();
      }
    },
  }));

  if (tunnelItems.length === 0) {
    tunnelItems.push({
      label: "No tunnels configured",
      enabled: false,
    });
  }

  return Menu.buildFromTemplate([
    ...tunnelItems,
    { type: "separator" },
    {
      label: "Add Tunnel...",
      click: () => openAddWindow(),
    },
    {
      label: "Sync Now",
      click: async () => {
        await sync();
        await updateTray();
      },
    },
    { type: "separator" },
    {
      label: `Config: ${getConfigPath()}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
}

async function updateTray(): Promise<void> {
  if (!tray) return;
  const menu = await buildTrayMenu();
  tray.setContextMenu(menu);
  tray.setImage(createTrayIcon(getTrayState()));

  const enabled = currentStatuses.filter((s) => s.enabled);
  const running = enabled.filter((s) => s.alive && s.portOpen);
  tray.setToolTip(`SSH Tunnels: ${running.length}/${enabled.length} running`);
}

function openAddWindow(): void {
  if (addWindow) {
    addWindow.focus();
    return;
  }

  addWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Add SSH Tunnel",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  addWindow.loadFile(join(__dirname, "..", "renderer", "add-tunnel.html"));

  addWindow.on("closed", () => {
    addWindow = null;
  });
}

// IPC handlers
ipcMain.handle("get-statuses", async () => {
  await refreshStatuses();
  return currentStatuses;
});

ipcMain.handle("add-tunnel", async (_event, tunnelData: Omit<TunnelConfig, "id" | "extraArgs">) => {
  console.log("IPC add-tunnel received:", JSON.stringify(tunnelData));
  const config = await readConfig();
  const id = slugify(tunnelData.name);

  if (config.tunnels.some((t) => t.id === id)) {
    throw new Error(`Tunnel with id '${id}' already exists`);
  }

  const tunnel: TunnelConfig = {
    ...tunnelData,
    id,
    extraArgs: [],
  };

  config.tunnels.push(tunnel);
  await writeConfig(config);

  if (tunnel.enabled) {
    await sync(config);
  }

  await updateTray();
  return tunnel;
});

ipcMain.handle("toggle-tunnel", async (_event, id: string) => {
  const config = await readConfig();
  const tunnel = config.tunnels.find((t) => t.id === id);
  if (!tunnel) throw new Error(`Tunnel '${id}' not found`);

  tunnel.enabled = !tunnel.enabled;
  await writeConfig(config);
  await sync(config);
  await updateTray();
  return tunnel.enabled;
});

ipcMain.handle("remove-tunnel", async (_event, id: string) => {
  const config = await readConfig();
  const idx = config.tunnels.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Tunnel '${id}' not found`);

  config.tunnels.splice(idx, 1);
  await writeConfig(config);
  await stopTunnel(id);
  await updateTray();
});

// App lifecycle
app.dock?.hide(); // Hide dock icon — we're a menu bar app

app.whenReady().then(async () => {
  tray = new Tray(createTrayIcon("yellow"));
  tray.setToolTip("SSH Tunnels — loading...");

  // Refresh menu every time the user clicks the tray icon
  tray.on("mouse-down", async () => {
    await updateTray();
  });

  await updateTray();

  // Watch config for external changes (e.g., from CLI)
  configWatcher = watchConfig({
    onSync: async () => {
      await updateTray();
    },
    onError: (err) => {
      console.error("Config watch error:", err);
    },
  });

  // Periodic sync for auto-recovery (every 30s)
  syncTimer = setInterval(async () => {
    try {
      await sync();
      await updateTray();
    } catch (err) {
      console.error("Periodic sync error:", err);
    }
  }, 30_000);
});

app.on("before-quit", async () => {
  if (configWatcher) await configWatcher.close();
  if (syncTimer) clearInterval(syncTimer);
});

// Prevent quitting when all windows close (we're a tray app)
app.on("window-all-closed", () => {
  // Don't quit
});
