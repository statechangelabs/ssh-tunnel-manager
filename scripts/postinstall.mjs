import { mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const home = homedir();

// 1. Create directories
const baseDir = join(home, ".ssh-tunnels");
const pidsDir = join(baseDir, "pids");
const historyDir = join(baseDir, "history");

await mkdir(baseDir, { recursive: true });
await mkdir(pidsDir, { recursive: true });
await mkdir(historyDir, { recursive: true });
console.log(`Created directories: ${baseDir}/{pids,history}`);

// 2. macOS LaunchAgent setup
if (platform() !== "darwin") {
  console.log("Not macOS — skipping LaunchAgent setup.");
  console.log("Done.");
  process.exit(0);
}

// Resolve paths
const packageRoot = join(__dirname, "..");
const appEntry = join(packageRoot, "dist", "app.mjs");

// Find node and npx absolute paths
let nodeBin;
try {
  nodeBin = execSync("which node", { encoding: "utf-8" }).trim();
} catch {
  console.warn("Could not find node in PATH — skipping LaunchAgent setup.");
  console.log("Done (dirs created).");
  process.exit(0);
}

let npxBin;
try {
  npxBin = execSync("which npx", { encoding: "utf-8" }).trim();
} catch {
  npxBin = join(dirname(nodeBin), "npx");
}

const nodeBinDir = dirname(nodeBin);

// 3. Write LaunchAgent plist
const launchAgentsDir = join(home, "Library", "LaunchAgents");
await mkdir(launchAgentsDir, { recursive: true });

const plistPath = join(launchAgentsDir, "com.statechange.ssh-tunnel-manager.plist");
const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.statechange.ssh-tunnel-manager</string>
    <key>ProgramArguments</key>
    <array>
        <string>${npxBin}</string>
        <string>electron</string>
        <string>${appEntry}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${packageRoot}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${nodeBinDir}:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${home}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${historyDir}/app-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${historyDir}/app-stderr.log</string>
</dict>
</plist>
`;

// Unload existing agent before overwriting (idempotent)
try {
  execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
} catch {
  // Not loaded — that's fine
}

await writeFile(plistPath, plistContent, "utf-8");
console.log(`Wrote LaunchAgent: ${plistPath}`);

// 4. Load the LaunchAgent
try {
  execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
  console.log("LaunchAgent loaded (menu bar app will start).");
} catch {
  console.warn("Failed to load LaunchAgent — you may need to load it manually:");
  console.warn(`  launchctl load "${plistPath}"`);
}

// 5. Summary
console.log("");
console.log("SSH Tunnel Manager installed:");
console.log(`  CLI command:    ssh-tunnels`);
console.log(`  Config file:    ${join(baseDir, "config.json")}`);
console.log(`  PID files:      ${pidsDir}/`);
console.log(`  Log files:      ${historyDir}/`);
console.log(`  LaunchAgent:    ${plistPath}`);
console.log(`  Menu bar app:   ${appEntry}`);
console.log("");
console.log("Get started: ssh-tunnels status");
