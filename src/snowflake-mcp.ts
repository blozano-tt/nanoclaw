/**
 * Host-side Snowflake MCP server management.
 *
 * Runs the official Snowflake-Labs MCP (Python) as an HTTP server on the host.
 * Containers connect to it via host.containers.internal — the private key
 * never enters the container.
 */

import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

import { readEnvFile } from './env.js';
import { logger as rootLogger } from './logger.js';
import { PROXY_BIND_HOST } from './container-runtime.js';

const logger = rootLogger.child({ module: 'snowflake-mcp' });

export interface SnowflakeMcpConfig {
  account: string;
  username: string;
  privateKeyFile: string;
  role?: string;
  warehouse?: string;
  port: number;
  serviceConfigFile: string;
}

let mcpProcess: ChildProcess | null = null;

/**
 * Read Snowflake config from .env and return it, or null if not configured.
 */
function loadConfig(): SnowflakeMcpConfig | null {
  const env = readEnvFile([
    'SNOWFLAKE_ACCOUNT',
    'SNOWFLAKE_USERNAME',
    'SNOWFLAKE_PRIVATE_KEY_FILE',
    'SNOWFLAKE_ROLE',
    'SNOWFLAKE_WAREHOUSE',
    'SNOWFLAKE_MCP_PORT',
  ]);

  const account = env.SNOWFLAKE_ACCOUNT || process.env.SNOWFLAKE_ACCOUNT;
  const username = env.SNOWFLAKE_USERNAME || process.env.SNOWFLAKE_USERNAME;
  const privateKeyFile =
    env.SNOWFLAKE_PRIVATE_KEY_FILE || process.env.SNOWFLAKE_PRIVATE_KEY_FILE;

  if (!account || !username || !privateKeyFile) {
    return null;
  }

  if (!fs.existsSync(privateKeyFile)) {
    logger.error({ privateKeyFile }, 'Snowflake private key file not found');
    return null;
  }

  const serviceConfigFile = path.resolve(
    process.cwd(),
    'services',
    'snowflake-mcp-config.yaml',
  );

  if (!fs.existsSync(serviceConfigFile)) {
    logger.error(
      { serviceConfigFile },
      'Snowflake MCP service config not found',
    );
    return null;
  }

  return {
    account,
    username,
    privateKeyFile,
    role: env.SNOWFLAKE_ROLE || process.env.SNOWFLAKE_ROLE,
    warehouse: env.SNOWFLAKE_WAREHOUSE || process.env.SNOWFLAKE_WAREHOUSE,
    port: parseInt(
      env.SNOWFLAKE_MCP_PORT || process.env.SNOWFLAKE_MCP_PORT || '8085',
      10,
    ),
    serviceConfigFile,
  };
}

/**
 * Start the Snowflake MCP HTTP server on the host.
 * Returns true if started (or already running), false if not configured.
 */
export function startSnowflakeMcp(): boolean {
  if (mcpProcess && !mcpProcess.killed) {
    logger.warn('Snowflake MCP server already running');
    return true;
  }

  const config = loadConfig();
  if (!config) {
    logger.info(
      'Snowflake MCP not configured (set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USERNAME, SNOWFLAKE_PRIVATE_KEY_FILE in .env)',
    );
    return false;
  }

  // Resolve uvx path
  const home = process.env.HOME || '/root';
  const uvxPath = path.join(home, '.local', 'bin', 'uvx');
  if (!fs.existsSync(uvxPath)) {
    logger.error(
      { uvxPath },
      'uvx not found — install with: curl -LsSf https://astral.sh/uv/install.sh | sh',
    );
    return false;
  }

  const args: string[] = [
    'snowflake-labs-mcp',
    '--transport',
    'streamable-http',
    '--port',
    String(config.port),
    '--server-host',
    PROXY_BIND_HOST,
    '--account',
    config.account,
    '--user',
    config.username,
    '--private-key-file',
    config.privateKeyFile,
    '--service-config-file',
    config.serviceConfigFile,
  ];

  if (config.role) {
    args.push('--role', config.role);
  }
  if (config.warehouse) {
    args.push('--warehouse', config.warehouse);
  }

  logger.info(
    { port: config.port, account: config.account, user: config.username },
    'Starting Snowflake MCP server',
  );

  mcpProcess = spawn(uvxPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  mcpProcess.stdout?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) logger.debug({ stream: 'stdout' }, text);
  });

  mcpProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      // FastMCP uses stderr for its INFO logs
      if (text.includes('ERROR')) {
        logger.error({ stream: 'stderr' }, text);
      } else {
        logger.debug({ stream: 'stderr' }, text);
      }
    }
  });

  mcpProcess.on('exit', (code, signal) => {
    logger.warn({ code, signal }, 'Snowflake MCP server exited');
    mcpProcess = null;
  });

  return true;
}

/**
 * Stop the Snowflake MCP server.
 */
export function stopSnowflakeMcp(): void {
  if (mcpProcess && !mcpProcess.killed) {
    logger.info('Stopping Snowflake MCP server');
    mcpProcess.kill('SIGTERM');
    mcpProcess = null;
  }
}
