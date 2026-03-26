#!/bin/bash
# Start Snowflake-Labs MCP server in HTTP mode on the host.
# The container's agent-runner connects to this via HTTP — the private key
# never enters the container.
#
# Connection parameters (account, user, key, database, schema, etc.) are read
# from ~/.snowflake/connections.toml [default] — NOT from .env.
#
# Usage:  ./services/start-snowflake-mcp.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source uv
source "$HOME/.local/bin/env" 2>/dev/null || true

SNOWFLAKE_MCP_PORT="${SNOWFLAKE_MCP_PORT:-8085}"

exec uvx snowflake-labs-mcp \
  --transport streamable-http \
  --port "$SNOWFLAKE_MCP_PORT" \
  --server-host 0.0.0.0 \
  --connection-name default \
  --service-config-file "$SCRIPT_DIR/snowflake-mcp-config.yaml"
