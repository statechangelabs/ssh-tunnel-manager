# SSH Tunnel Manager

Declarative SSH tunnel manager with a CLI and macOS menu bar app. Define your tunnels in a JSON config — the tool keeps them running.

```
localhost:5432 ──► bastion.example.com ──► db.internal:5432
localhost:8080 ──► jump.example.com   ──► admin.internal:8080
```

## Install

### With an AI agent (recommended)

The best way to use SSH Tunnel Manager is through an AI agent skill. Install the skill, then just tell your agent what tunnels you need — it handles the rest.

```bash
npx skills add statechangelabs/ssh-tunnel-manager
```

This adds the `ssh-tunnel` and `ssh-tunnel-debug` skills to your agent. Then you can say things like:

> "Set up an SSH tunnel to my Postgres database on bastion.example.com"

> "My tunnel to the staging server isn't connecting"

The agent will install the CLI if needed, create the tunnel, verify it's working, and troubleshoot any issues.

### Direct install

```bash
npm install -g @statechange/ssh-tunnel-manager
```

This single command:
- Installs the `ssh-tunnels` CLI globally
- Creates `~/.ssh-tunnels/` directories
- Sets up a macOS LaunchAgent for the menu bar app
- Starts the menu bar app automatically

## CLI Usage

```bash
# See all tunnels and their status
ssh-tunnels status

# Add a tunnel
ssh-tunnels add \
  --name "Prod Postgres" \
  --host bastion.example.com \
  --user root \
  --localPort 5433 \
  --remoteHost db.internal \
  --remotePort 5432 \
  --enabled

# Enable / disable / remove
ssh-tunnels enable prod-postgres
ssh-tunnels disable prod-postgres
ssh-tunnels remove prod-postgres

# View logs (first place to look when a tunnel fails)
ssh-tunnels logs prod-postgres

# Sync all tunnels to match config
ssh-tunnels sync

# Watch config and auto-sync on changes
ssh-tunnels watch

# JSON output for scripting / AI agents
ssh-tunnels status --json
ssh-tunnels enable prod-postgres --json
```

## Menu Bar App

The Electron menu bar app runs as a macOS LaunchAgent and provides:

- **Tray icon** — green (all OK), yellow (partially running), red (failures)
- **Click to toggle** tunnels on/off
- **Add Tunnel** form
- **Sync Now** button
- **Auto-recovery** — syncs every 30 seconds, restarts crashed tunnels

The app and CLI share the same config file (`~/.ssh-tunnels/config.json`). Changes from either side are reflected in both.

## How It Works

Tunnels are defined in `~/.ssh-tunnels/config.json`:

```json
{
  "tunnels": [
    {
      "id": "prod-postgres",
      "name": "Prod Postgres",
      "host": "bastion.example.com",
      "user": "root",
      "localPort": 5433,
      "remoteHost": "db.internal",
      "remotePort": 5432,
      "enabled": true
    }
  ]
}
```

When a tunnel is enabled, the manager spawns a detached `ssh -N -L ...` process and writes its PID to `~/.ssh-tunnels/pids/`. The `sync` command reconciles running processes against the config — starting missing tunnels and stopping ones that should be off.

## Common Ports

| Port  | Service     |
|-------|-------------|
| 5432  | PostgreSQL  |
| 3306  | MySQL       |
| 6379  | Redis       |
| 27017 | MongoDB     |
| 8080  | Dev server  |
| 9200  | Elasticsearch |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Permission denied (publickey)" | Wrong SSH user | Recreate with `--user root` |
| Tunnel stops immediately | Auth failure or port conflict | `ssh-tunnels logs <id>` |
| "Address already in use" | Port conflict | `lsof -i :<port>` |
| Tunnel starts but port not open | Remote service down | SSH in and check the service |

For detailed diagnostics, install the `ssh-tunnel-debug` skill or check the [debug guide](skills/ssh-tunnel-debug/SKILL.md).

## Uninstall

```bash
# Stop the menu bar app and remove the LaunchAgent
launchctl unload ~/Library/LaunchAgents/com.statechange.ssh-tunnel-manager.plist
rm ~/Library/LaunchAgents/com.statechange.ssh-tunnel-manager.plist

# Remove the CLI
npm uninstall -g @statechange/ssh-tunnel-manager

# Optionally remove config and data
rm -rf ~/.ssh-tunnels
```

## License

MIT
