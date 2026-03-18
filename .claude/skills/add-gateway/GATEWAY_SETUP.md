# BrAIn Gateway Setup Guide

This guide walks through setting up the **BrAIn Gateway** — a shared Slack message router — and connecting individual NanoClaw instances to it.

## Overview

```
                              ┌─────────────────────┐
                              │   Slack Workspace    │
                              │  (single BrAIn app)  │
                              └──────────┬──────────┘
                                         │ Socket Mode
                              ┌──────────▼──────────┐
                              │   BrAIn Gateway      │
                              │   (gateway-vm:8080)  │
                              └──┬──────┬──────┬────┘
                     HTTP /message│      │      │
                    ┌─────────┘  │      └───────────┐
                    ▼            ▼                   ▼
              ┌───────────┐ ┌───────────┐     ┌───────────┐
              │ NanoClaw  │ │ NanoClaw  │     │ NanoClaw  │
              │ (Alice)   │ │ (Bob)     │ ... │ (Bryan)   │
              │ coder-vm  │ │ coder-vm  │     │ coder-vm  │
              └───────────┘ └───────────┘     └───────────┘
```

**One Slack app → One gateway → Many NanoClaw instances.**

## Part 1: Gateway Setup (Admin — One-Time)

### 1. Provision a Gateway VM

Any persistent VM with:
- Node.js 20+
- Network connectivity to all coder VMs
- Ports 8080 (HTTP API) open to coder VMs

### 2. Clone and configure the gateway

```bash
git clone git@github.com:blozano-tt/brAInGateway.git
cd brAInGateway
npm install
```

Create `.env`:

```bash
# Slack tokens (from the BrAIn Slack app)
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Shared secret — all NanoClaw instances must use this
GATEWAY_SECRET=generate-a-strong-random-string

# HTTP API port
PORT=8080
```

### 3. Start the gateway

```bash
npm run build
npm start
```

Or with systemd:

```bash
# Create ~/.config/systemd/user/brain-gateway.service
[Unit]
Description=BrAIn Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/you/brAInGateway
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now brain-gateway
```

### 4. Verify

```bash
curl http://localhost:8080/health
# → {"ok":true}
```

## Part 2: NanoClaw Instance Setup (Each User)

### 1. Apply the gateway skill

From the NanoClaw directory:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-gateway
```

Or ask Claude to apply it for you — the `SKILL.md` has full instructions.

### 2. Configure environment

Add to `.env`:

```bash
# Gateway connection
GATEWAY_URL=http://gateway-vm:8080
GATEWAY_SECRET=the-shared-secret-from-admin
GATEWAY_AGENT_ID=alice-brain
GATEWAY_AGENT_NAME=BrAIn
GATEWAY_OWNER_SLACK_ID=U07J3K6KS1K

# Port this instance listens on for forwarded messages
GATEWAY_LISTEN_PORT=9090

# Optional: channels this instance handles (comma-separated)
# If empty, the instance only handles DMs from the owner
GATEWAY_CHANNELS=C0AJNU16ZGX,C09CK9093LH

# Optional: if your VM hostname isn't resolvable from the gateway
# GATEWAY_EXTERNAL_HOST=10.0.0.42
```

**Important**: Remove or comment out `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` if they were previously set — you don't want the direct Slack connection competing with the gateway.

Sync to container:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 3. Build and restart

```bash
npm run build
systemctl --user restart nanoclaw
```

### 4. Verify registration

```bash
# On the gateway VM:
curl -s -H "Authorization: Bearer $GATEWAY_SECRET" http://localhost:8080/status | jq .
```

You should see your agent listed as healthy.

### 5. Test

DM the BrAIn bot in Slack, or message in one of your registered channels. The flow is:

1. Slack → Gateway (Socket Mode)
2. Gateway → Your NanoClaw (`POST /message`)
3. NanoClaw processes, generates response
4. NanoClaw → Gateway (`POST /respond`)
5. Gateway → Slack (`chat.postMessage`)

## Routing Rules

The gateway uses this priority for routing:

1. **Channel messages**: If a channel ID is registered by an agent, messages in that channel go to that agent.
2. **DMs**: When a user DMs the bot, the gateway looks up which agent has that user as `ownerSlackId` and routes to them.
3. **Unrouted**: If no agent matches, the gateway replies with a "no agent available" message.

## Networking

The gateway and NanoClaw instances communicate over HTTP. Ensure:

- **Gateway → NanoClaw**: The gateway must be able to reach each NanoClaw's `GATEWAY_LISTEN_PORT`. If on the same network, hostnames work. If not, set `GATEWAY_EXTERNAL_HOST` to the IP.
- **NanoClaw → Gateway**: Each NanoClaw must be able to reach `GATEWAY_URL`.
- **Firewalls**: Open port `9090` (or your configured `GATEWAY_LISTEN_PORT`) on each coder VM.

## Troubleshooting

### Agent shows unhealthy

The gateway marks agents unhealthy after 5 minutes without a heartbeat.

```bash
# Check NanoClaw logs:
journalctl --user -u nanoclaw -f | grep gateway

# Check network:
curl http://gateway-vm:8080/health
```

### Messages not reaching NanoClaw

```bash
# Check the gateway can reach your VM:
curl http://your-vm:9090/health

# Check NanoClaw is listening:
ss -tlnp | grep 9090
```

### DMs not working

- Ensure the Slack app has `im:history`, `im:read`, `im:write` scopes
- Ensure `GATEWAY_OWNER_SLACK_ID` matches your actual Slack user ID
- The bot must be able to receive DMs (Slack app settings → **App Home** → check "Allow users to send Slash commands and messages from the messages tab")

## Security Notes

- **`GATEWAY_SECRET`** is a shared bearer token. Treat it like a password.
- The gateway does **not** authenticate individual NanoClaw instances beyond the shared secret. Any instance with the secret can register.
- Messages are sent over HTTP (not HTTPS) by default. For production, put the gateway behind a TLS reverse proxy or use a VPN/private network.
- NanoClaw containers do **not** receive the gateway secret — it stays on the host in `.env`.
