import { Command } from "commander";
import {
  readConfig,
  writeConfig,
  slugify,
  sync,
  getStatus,
  watchConfig,
  getLogFilePath,
  getConfigPath,
  type TunnelConfig,
  type TunnelStatus,
} from "../core/index.js";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";

const program = new Command();

program
  .name("ssh-tunnels")
  .description(
`Declarative SSH tunnel manager.

Manages SSH tunnels via a JSON config file at ~/.ssh-tunnels/config.json.
Each tunnel defines a local port that forwards through an SSH host to a
remote host:port. The CLI synchronizes running SSH processes to match
the desired state in the config.

COMMON PORTS:
  5432    PostgreSQL
  3306    MySQL
  6379    Redis
  27017   MongoDB
  80/443  HTTP/HTTPS (web interfaces)
  8080    Common dev server / admin UI
  8089    Splunk / custom services
  18789   OpenClaw admin
  3000    Node.js dev server
  9200    Elasticsearch

WORKFLOW:
  1. Add a tunnel:     ssh-tunnels add --name "My DB" --host bastion.example.com ...
  2. Enable & start:   ssh-tunnels enable my-db
  3. Check status:     ssh-tunnels status
  4. View logs:        ssh-tunnels logs my-db
  5. Disable & stop:   ssh-tunnels disable my-db

GOTCHAS:
  - The --user flag defaults to your local OS username ($USER). Many servers
    require "root" or a specific service account. If you see "Permission denied
    (publickey)" in the logs, the username is likely wrong.
  - The --remoteHost is resolved FROM the SSH host, not from your machine.
    Use "localhost" if the service runs on the SSH host itself.
  - If a tunnel shows "stopped" right after enabling, check the logs with
    "ssh-tunnels logs <id>" — common causes are wrong username, missing SSH
    key, host key verification failure, or the remote port not being open.
  - The tunnel ID is auto-generated from the name (slugified). Use the ID
    (not the name) for enable/disable/remove/logs commands.
  - If your SSH key is not the default (~/.ssh/id_rsa or ~/.ssh/id_ed25519),
    pass --identityFile explicitly.
  - Local port conflicts will cause the tunnel to fail immediately. Check
    "lsof -i :<port>" if a tunnel won't start.`
  )
  .version("0.1.0");

let jsonOutput = false;
program.option("--json", "Output as JSON (for programmatic/AI consumption)").hook("preAction", (cmd) => {
  jsonOutput = cmd.opts().json ?? false;
});

function output(data: unknown): void {
  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(data);
  }
}

function formatStatus(s: TunnelStatus): string {
  const stateIcon = s.alive && s.portOpen ? "●" : "○";
  const stateText = s.alive && s.portOpen ? "running" : "stopped";
  const enabledText = s.enabled ? "enabled" : "disabled";
  return `${stateIcon} ${s.name} (${s.id}) — ${stateText}, ${enabledText} — localhost:${s.localPort} → ${s.remoteHost}:${s.remotePort} via ${s.host} (user: ${(s as any).user ?? "unknown"})`;
}

async function verboseStatusCheck(id: string, expectRunning: boolean): Promise<void> {
  // Wait for SSH to establish (or fail)
  await new Promise((r) => setTimeout(r, 2500));

  const statuses = await getStatus();
  const s = statuses.find((t) => t.id === id);
  if (!s) return;

  const running = s.alive && s.portOpen;

  if (expectRunning && !running) {
    console.log("");
    console.log(`WARNING: Tunnel '${s.name}' (${id}) was started but is not running.`);
    console.log(`  Expected state: running on localhost:${s.localPort}`);
    console.log(`  Actual state:   ${s.alive ? "process alive but port not open" : "process not running"}`);
    console.log("");
    console.log("  Troubleshooting:");
    console.log(`    1. Check logs:  ssh-tunnels logs ${id}`);
    console.log("    2. Common causes:");
    console.log("       - Wrong SSH user (use --user root if the server requires root)");
    console.log("       - SSH key not authorized on the remote host");
    console.log("       - Host key verification failed (first connection to this host)");
    console.log(`       - Local port ${s.localPort} already in use (check: lsof -i :${s.localPort})`);
    console.log(`       - Remote service not listening on ${s.remoteHost}:${s.remotePort}`);

    // Try to show the last few lines of the log
    try {
      const logContent = await readFile(getLogFilePath(id), "utf-8");
      const lines = logContent.trim().split("\n").slice(-5);
      if (lines.length > 0 && lines[0].length > 0) {
        console.log("");
        console.log(`  Recent log output (${getLogFilePath(id)}):`);
        for (const line of lines) {
          console.log(`    ${line}`);
        }
      }
    } catch {
      // No log file
    }
  } else if (expectRunning && running) {
    console.log(`Verified: tunnel is running — localhost:${s.localPort} is accepting connections.`);
  }
}

// --- sync ---
program
  .command("sync")
  .description(
`One-shot reconciliation: start all enabled tunnels, stop all disabled ones.

Compares the desired state in ~/.ssh-tunnels/config.json against actually
running SSH processes. Starts missing tunnels, kills ones that should be
off, and cleans up stale PID files from crashed processes.

Examples:
  ssh-tunnels sync          # Reconcile everything
  ssh-tunnels sync --json   # Machine-readable output`)
  .action(async () => {
    const result = await sync();
    if (jsonOutput) {
      output(result);
    } else {
      if (result.started.length) console.log(`Started: ${result.started.join(", ")}`);
      if (result.stopped.length) console.log(`Stopped: ${result.stopped.join(", ")}`);
      if (result.alreadyRunning.length) console.log(`Already running: ${result.alreadyRunning.join(", ")}`);
      if (result.alreadyStopped.length) console.log(`Already stopped: ${result.alreadyStopped.join(", ")}`);
      if (result.errors.length) {
        for (const e of result.errors) {
          console.error(`Error [${e.id}]: ${e.error}`);
        }
      }
      if (!result.started.length && !result.stopped.length && !result.errors.length) {
        console.log("Everything in sync.");
      }
    }
  });

// --- status ---
program
  .command("status")
  .description(
`Show the current state of all configured tunnels.

Displays each tunnel's name, ID, running/stopped state, enabled/disabled
flag, and port mapping. Use --json for structured output.

Examples:
  ssh-tunnels status          # Human-readable table
  ssh-tunnels status --json   # JSON array of tunnel status objects

Status indicators:
  ● = running (SSH process alive + local port accepting connections)
  ○ = stopped (process dead or port not responding)`)
  .action(async () => {
    const statuses = await getStatus();
    if (jsonOutput) {
      output(statuses);
    } else {
      if (statuses.length === 0) {
        console.log("No tunnels configured.");
        console.log("");
        console.log("Get started by adding a tunnel:");
        console.log('  ssh-tunnels add --name "My Database" --host bastion.example.com --user root --localPort 5432 --remoteHost localhost --remotePort 5432 --enabled');
        console.log("");
        console.log(`Config file: ${getConfigPath()}`);
        return;
      }
      console.log(`Tunnels (config: ${getConfigPath()}):`);
      console.log("");
      for (const s of statuses) {
        const stateIcon = s.alive && s.portOpen ? "●" : "○";
        const stateText = s.alive && s.portOpen ? "running" : "stopped";
        const enabledText = s.enabled ? "enabled" : "disabled";
        console.log(`  ${stateIcon} ${s.name} (${s.id})`);
        console.log(`    State:   ${stateText}, ${enabledText}`);
        console.log(`    Local:   localhost:${s.localPort}`);
        console.log(`    Remote:  ${s.remoteHost}:${s.remotePort} via ${s.host}`);
        if (s.pid) console.log(`    PID:     ${s.pid}`);
        if (s.enabled && !s.alive) {
          console.log(`    Issue:   Tunnel is enabled but not running. Check: ssh-tunnels logs ${s.id}`);
        }
        console.log("");
      }
    }
  });

// --- add ---
program
  .command("add")
  .description(
`Add a new SSH tunnel to the config.

Creates a tunnel definition that forwards a local port through an SSH host
to a remote host:port. The tunnel is saved to ~/.ssh-tunnels/config.json.

IMPORTANT: --user defaults to your current OS user ("${process.env.USER ?? "unknown"}").
Many servers require "root" or a dedicated user. If the tunnel fails with
"Permission denied (publickey)", try a different --user value.

The --remoteHost is resolved FROM the SSH host's perspective. Use "localhost"
when the target service runs on the SSH host itself.

Examples:
  # PostgreSQL through a bastion (connect as root):
  ssh-tunnels add --name "Prod Postgres" --host bastion.example.com \\
    --user root --localPort 5433 --remoteHost db.internal --remotePort 5432 --enabled

  # Web admin UI on a remote server (port 8089, service on the host itself):
  ssh-tunnels add --name "Admin Panel" --host admin.example.com \\
    --user root --localPort 8089 --remoteHost localhost --remotePort 8089 --enabled

  # Redis on an internal network, non-default SSH port:
  ssh-tunnels add --name "Staging Redis" --host jump.example.com \\
    --user deploy --localPort 6380 --remoteHost redis.staging --remotePort 6379 \\
    --sshPort 2222 --identityFile ~/.ssh/staging_key --enabled

  # Add without enabling (start later with "ssh-tunnels enable <id>"):
  ssh-tunnels add --name "Dev Server" --host dev.example.com \\
    --user ray --localPort 3000 --remoteHost localhost --remotePort 3000

Common port reference:
  5432=PostgreSQL  3306=MySQL  6379=Redis  27017=MongoDB
  80/443=HTTP(S)   8080=Dev server  8089=Splunk  18789=OpenClaw admin`)
  .requiredOption("--name <name>", "Display name for the tunnel (used to generate the ID)")
  .requiredOption("--host <host>", "SSH host to connect through (IP or hostname)")
  .requiredOption("--localPort <port>", "Port on your machine to listen on", parseInt)
  .requiredOption("--remoteHost <host>", 'Target host from the SSH server\'s perspective (often "localhost")')
  .requiredOption("--remotePort <port>", "Target port on the remote host", parseInt)
  .option("--user <user>", `SSH username (default: "${process.env.USER ?? ""}" — many servers need "root")`, process.env.USER ?? "")
  .option("--identityFile <path>", "Path to SSH private key (e.g., ~/.ssh/id_ed25519)")
  .option("--sshPort <port>", "SSH port if not 22", parseInt)
  .option("--enabled", "Enable and start the tunnel immediately", false)
  .action(async (opts) => {
    const config = await readConfig();
    const id = slugify(opts.name);

    if (config.tunnels.some((t) => t.id === id)) {
      console.error(`Error: Tunnel with id '${id}' already exists.`);
      console.error(`  To update it, remove it first: ssh-tunnels remove ${id}`);
      console.error(`  To see existing tunnels: ssh-tunnels status`);
      process.exit(1);
    }

    // Validate port range
    if (opts.localPort < 1 || opts.localPort > 65535) {
      console.error(`Error: --localPort must be between 1 and 65535 (got ${opts.localPort}).`);
      process.exit(1);
    }
    if (opts.remotePort < 1 || opts.remotePort > 65535) {
      console.error(`Error: --remotePort must be between 1 and 65535 (got ${opts.remotePort}).`);
      process.exit(1);
    }

    const tunnel: TunnelConfig = {
      id,
      name: opts.name,
      host: opts.host,
      user: opts.user,
      localPort: opts.localPort,
      remoteHost: opts.remoteHost,
      remotePort: opts.remotePort,
      enabled: opts.enabled ?? false,
      ...(opts.identityFile && { identityFile: opts.identityFile }),
      ...(opts.sshPort && { sshPort: opts.sshPort }),
      extraArgs: [],
    };

    config.tunnels.push(tunnel);
    await writeConfig(config);

    if (jsonOutput) {
      const result = tunnel.enabled ? await sync(config) : null;
      if (tunnel.enabled) await new Promise((r) => setTimeout(r, 2500));
      const statuses = await getStatus(config);
      const status = statuses.find((s) => s.id === id);
      output({
        action: "added",
        tunnel,
        sync: result,
        status: status ?? null,
        healthy: status ? (status.alive && status.portOpen) : null,
        logFile: getLogFilePath(id),
        configFile: getConfigPath(),
      });
    } else {
      console.log(`Added tunnel '${tunnel.name}' (${tunnel.id})`);
      console.log(`  SSH:    ${tunnel.user}@${tunnel.host}${tunnel.sshPort ? `:${tunnel.sshPort}` : ""}`);
      console.log(`  Forward: localhost:${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}`);
      console.log(`  Enabled: ${tunnel.enabled}`);
      console.log(`  Config: ${getConfigPath()}`);
      console.log(`  Logs:   ${getLogFilePath(id)}`);

      if (tunnel.enabled) {
        console.log("");
        console.log("Starting tunnel...");
        const result = await sync(config);
        if (result.started.length) {
          console.log(`SSH process spawned for: ${result.started.join(", ")}`);
        }
        if (result.errors.length) {
          for (const e of result.errors) {
            console.error(`Error starting ${e.id}: ${e.error}`);
          }
        }
        await verboseStatusCheck(id, true);
      } else {
        console.log("");
        console.log(`Tunnel saved but not started. To start it:`);
        console.log(`  ssh-tunnels enable ${id}`);
      }
    }
  });

// --- remove ---
program
  .command("remove <id>")
  .description(
`Remove a tunnel from the config and stop it if running.

The tunnel definition is deleted from ~/.ssh-tunnels/config.json and any
running SSH process for it is terminated.

To find the tunnel ID, run: ssh-tunnels status

Examples:
  ssh-tunnels remove my-database
  ssh-tunnels remove prod-postgres`)
  .action(async (id: string) => {
    const config = await readConfig();
    const idx = config.tunnels.findIndex((t) => t.id === id);
    if (idx === -1) {
      console.error(`Error: Tunnel '${id}' not found.`);
      console.error("");
      console.error("Available tunnels:");
      for (const t of config.tunnels) {
        console.error(`  - ${t.id} (${t.name})`);
      }
      if (config.tunnels.length === 0) {
        console.error("  (none configured)");
      }
      process.exit(1);
    }

    const [removed] = config.tunnels.splice(idx, 1);
    await writeConfig(config);

    const { stopTunnel } = await import("../core/index.js");
    await stopTunnel(id);

    if (jsonOutput) {
      output({ action: "removed", tunnel: removed, configFile: getConfigPath() });
    } else {
      console.log(`Removed tunnel '${removed.name}' (${id})`);
      console.log(`  SSH process stopped (if it was running).`);
      console.log(`  Config updated: ${getConfigPath()}`);
    }
  });

// --- enable ---
program
  .command("enable <id>")
  .description(
`Enable a tunnel and start it.

Sets enabled=true in the config and immediately starts the SSH process.
After starting, verifies the tunnel is healthy (process alive + port open).

Examples:
  ssh-tunnels enable my-database
  ssh-tunnels enable prod-postgres --json`)
  .action(async (id: string) => {
    const config = await readConfig();
    const tunnel = config.tunnels.find((t) => t.id === id);
    if (!tunnel) {
      console.error(`Error: Tunnel '${id}' not found.`);
      console.error("");
      console.error("Available tunnels:");
      for (const t of config.tunnels) {
        console.error(`  - ${t.id} (${t.name}) [${t.enabled ? "enabled" : "disabled"}]`);
      }
      process.exit(1);
    }

    if (tunnel.enabled) {
      console.log(`Tunnel '${tunnel.name}' (${id}) is already enabled. Running sync...`);
    }

    tunnel.enabled = true;
    await writeConfig(config);
    const result = await sync(config);

    if (jsonOutput) {
      await new Promise((r) => setTimeout(r, 2500));
      const statuses = await getStatus(config);
      const status = statuses.find((s) => s.id === id);
      output({
        action: "enabled",
        id,
        tunnel: { name: tunnel.name, host: tunnel.host, user: tunnel.user, localPort: tunnel.localPort, remoteHost: tunnel.remoteHost, remotePort: tunnel.remotePort },
        sync: result,
        status: status ?? null,
        healthy: status ? (status.alive && status.portOpen) : null,
        logFile: getLogFilePath(id),
      });
    } else {
      console.log(`Enabled tunnel '${tunnel.name}' (${id})`);
      console.log(`  Forward: localhost:${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort} via ${tunnel.user}@${tunnel.host}`);
      if (result.started.length) console.log(`  SSH process spawned.`);
      await verboseStatusCheck(id, true);
    }
  });

// --- disable ---
program
  .command("disable <id>")
  .description(
`Disable a tunnel and stop it.

Sets enabled=false in the config and terminates the SSH process (SIGTERM,
then SIGKILL if needed).

Examples:
  ssh-tunnels disable my-database
  ssh-tunnels disable prod-postgres --json`)
  .action(async (id: string) => {
    const config = await readConfig();
    const tunnel = config.tunnels.find((t) => t.id === id);
    if (!tunnel) {
      console.error(`Error: Tunnel '${id}' not found.`);
      console.error("");
      console.error("Available tunnels:");
      for (const t of config.tunnels) {
        console.error(`  - ${t.id} (${t.name}) [${t.enabled ? "enabled" : "disabled"}]`);
      }
      process.exit(1);
    }

    tunnel.enabled = false;
    await writeConfig(config);
    const result = await sync(config);

    if (jsonOutput) {
      output({ action: "disabled", id, tunnel: { name: tunnel.name }, sync: result });
    } else {
      console.log(`Disabled tunnel '${tunnel.name}' (${id})`);
      if (result.stopped.length) {
        console.log(`  SSH process terminated.`);
        console.log(`  Port ${tunnel.localPort} is now free.`);
      } else {
        console.log(`  (tunnel was already stopped)`);
      }
    }
  });

// --- watch ---
program
  .command("watch")
  .description(
`Watch the config file and auto-sync on changes.

Performs an initial sync, then monitors ~/.ssh-tunnels/config.json for
changes. When the config is modified (by the CLI, the Electron app, or
a text editor), tunnels are automatically started/stopped to match.

This is useful for keeping tunnels in sync when editing config.json
directly or when the Electron app modifies the config.

Examples:
  ssh-tunnels watch           # Run in foreground (Ctrl+C to stop)`)
  .action(async () => {
    console.log(`Watching for config changes: ${getConfigPath()}`);
    console.log("Press Ctrl+C to stop.\n");

    // Do an initial sync
    const initial = await sync();
    if (initial.started.length) console.log(`Initial sync — started: ${initial.started.join(", ")}`);
    if (initial.stopped.length) console.log(`Initial sync — stopped: ${initial.stopped.join(", ")}`);
    if (!initial.started.length && !initial.stopped.length) console.log("Initial sync — everything in sync.");
    console.log("");

    const watcher = watchConfig({
      onSync: (result) => {
        const ts = new Date().toLocaleTimeString();
        if (result.started.length) console.log(`[${ts}] Started: ${result.started.join(", ")}`);
        if (result.stopped.length) console.log(`[${ts}] Stopped: ${result.stopped.join(", ")}`);
        if (result.errors.length) {
          for (const e of result.errors) console.error(`[${ts}] Error [${e.id}]: ${e.error}`);
        }
        if (!result.started.length && !result.stopped.length && !result.errors.length) {
          console.log(`[${ts}] Config changed — no tunnel changes needed.`);
        }
      },
      onError: (err) => {
        console.error(`Watch error: ${err.message}`);
      },
    });

    const shutdown = async () => {
      console.log("\nShutting down watcher...");
      await watcher.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// --- logs ---
program
  .command("logs <id>")
  .description(
`Show log output for a tunnel.

Displays the SSH process output for the given tunnel. This is the first
place to look when a tunnel fails to connect.

Common log messages and what they mean:
  "Permission denied (publickey)"
    → Wrong SSH username or key not authorized. Try --user root.
  "Connection refused"
    → SSH server not running or wrong port.
  "Connection timed out"
    → Host unreachable, firewall blocking, or wrong hostname.
  "Host key verification failed"
    → First connection to host; remove old key or set StrictHostKeyChecking.
  "bind: Address already in use"
    → Another process is using the local port. Check with lsof -i :<port>.

Examples:
  ssh-tunnels logs my-database        # Show full log
  ssh-tunnels logs my-database -f     # Follow (tail -f) the log`)
  .option("-f, --follow", "Follow log output in real-time")
  .action(async (id: string, opts: { follow?: boolean }) => {
    // Verify the tunnel exists
    const config = await readConfig();
    const tunnel = config.tunnels.find((t) => t.id === id);
    if (!tunnel) {
      console.error(`Error: Tunnel '${id}' not found.`);
      console.error("");
      console.error("Available tunnels:");
      for (const t of config.tunnels) {
        console.error(`  - ${t.id} (${t.name})`);
      }
      process.exit(1);
    }

    const logPath = getLogFilePath(id);
    console.log(`Log file: ${logPath}`);
    console.log(`Tunnel: ${tunnel.name} (${tunnel.user}@${tunnel.host} → ${tunnel.remoteHost}:${tunnel.remotePort})`);
    console.log("---");

    if (opts.follow) {
      const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
      child.on("error", () => {
        console.error(`No logs found for tunnel '${id}'. The tunnel may not have been started yet.`);
        console.error(`  Try: ssh-tunnels enable ${id}`);
      });
    } else {
      const stream = createReadStream(logPath, "utf-8");
      stream.on("error", () => {
        console.error(`No logs found for tunnel '${id}'. The tunnel may not have been started yet.`);
        console.error(`  Try: ssh-tunnels enable ${id}`);
      });
      stream.pipe(process.stdout);
    }
  });

program.parse();
