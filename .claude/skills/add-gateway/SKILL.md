---
name: add-gateway
description: Connect NanoClaw to a BrAIn Gateway instead of directly to Slack. Enables multi-user deployments where one Slack app routes messages to many NanoClaw instances.
---

# Add Gateway Channel

This skill adds a Gateway channel to NanoClaw, allowing it to receive messages from a centralized BrAIn Gateway service instead of connecting directly to Slack. This is the recommended architecture for multi-user deployments.

## Architecture

```
Slack ←→ [BrAIn Gateway]  ←→  NanoClaw (Alice's VM)
          (shared VM)      ←→  NanoClaw (Bob's VM)
                           ←→  NanoClaw (Bryan's VM)
```

- **BrAIn Gateway**: A standalone Slack message router (separate repo). Holds the single Slack Socket Mode connection and routes messages to registered NanoClaw instances over HTTP.
- **GatewayChannel**: This skill. A NanoClaw channel that connects to the gateway instead of Slack directly. Handles registration, heartbeat, message receiving, and response posting.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `gateway` is in `applied_skills`, skip to Phase 3 (Setup).

### Prerequisites

- A BrAIn Gateway instance must be running and reachable from this VM
- The gateway admin must provide:
  - Gateway URL (e.g., `http://gateway-vm:8080`)
  - Gateway secret (shared bearer token)
- The user must know their Slack user ID (e.g., `U07J3K6KS1K`)

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-gateway
```

This deterministically:
- Adds `src/channels/gateway.ts` (GatewayChannel class with self-registration)
- Adds `src/channels/gateway.test.ts` (unit tests)
- Appends `import './gateway.js'` to `src/channels/index.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md`

### Validate code changes

```bash
npm test
npm run build
```

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
GATEWAY_URL=http://gateway-vm:8080
GATEWAY_SECRET=the-shared-secret
GATEWAY_AGENT_ID=my-unique-agent-id
GATEWAY_AGENT_NAME=BrAIn
GATEWAY_OWNER_SLACK_ID=U07J3K6KS1K
GATEWAY_LISTEN_PORT=9090
# Optional: comma-separated channel IDs this agent handles
# GATEWAY_CHANNELS=C0AJNU16ZGX,C09CK9093LH
```

Sync to container environment if applicable:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
# Linux (systemd):
systemctl --user restart nanoclaw
# macOS (launchctl):
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Check registration

On startup, the GatewayChannel will:
1. Start a local HTTP server on `GATEWAY_LISTEN_PORT` to receive forwarded messages
2. Register with the gateway at `GATEWAY_URL/register`
3. Begin sending heartbeats every 60 seconds

### Check gateway status

```bash
curl -s -H "Authorization: Bearer $GATEWAY_SECRET" http://gateway-vm:8080/status | jq .
```

You should see your agent listed with `healthy: true`.

### Test the connection

Send a DM to the bot in Slack, or message in a channel this agent is registered for.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep gateway
```

## Troubleshooting

### Agent not receiving messages

1. Verify `GATEWAY_URL`, `GATEWAY_SECRET`, `GATEWAY_OWNER_SLACK_ID` are set
2. Verify the gateway is reachable: `curl http://gateway-vm:8080/health`
3. Check the agent is registered: `curl -H "Authorization: Bearer $GATEWAY_SECRET" http://gateway-vm:8080/status`
4. Verify the gateway VM can reach this VM on `GATEWAY_LISTEN_PORT`

### Agent registered but not healthy

- The gateway marks agents unhealthy after 5 minutes without a heartbeat
- Check NanoClaw logs for heartbeat errors
- Check network connectivity between gateway and this VM

### Running alongside Slack channel

The gateway channel and direct Slack channel can coexist. However, for multi-user deployments, only the gateway should hold the Slack connection. If both are configured, the gateway channel takes priority for JIDs it handles. Set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to empty to disable direct Slack.

## Coexistence with Other Channels

The gateway channel registers with the name `gateway` and owns JIDs prefixed with `gateway:`. Messages forwarded from the gateway arrive with their original JIDs (e.g., `slack:C0AJNU16ZGX`), and the gateway channel transparently maps them so NanoClaw's routing, threading, and storage all work unchanged.

## Security

The `GATEWAY_SECRET` provides **bidirectional authentication**:
- **NanoClaw → Gateway**: All requests (register, heartbeat, respond) include `Authorization: Bearer <secret>`
- **Gateway → NanoClaw**: The gateway sends `Authorization: Bearer <secret>` when forwarding messages via `POST /message`. NanoClaw validates this and rejects unauthenticated requests with `401`.

This prevents unauthorized parties from injecting messages into a NanoClaw instance or impersonating it to the gateway.

## Known Limitations

- **Single gateway**: Each NanoClaw instance connects to one gateway. Multiple gateways are not supported.
- **No message queuing**: If the NanoClaw instance is down when a message arrives, the gateway will report delivery failure. Messages are not retried by the gateway (the user will see an "agent offline" message in Slack).
- **Network dependency**: Unlike direct Slack (Socket Mode over WebSocket), this requires the gateway VM to be able to reach the NanoClaw VM over HTTP. Firewalls or VPN issues may block connectivity.
