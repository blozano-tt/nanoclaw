/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Podman support: auto-detects podman on PATH and adjusts UID mapping,
 * SELinux mount labels, and proxy bind address accordingly.
 * Filed under upstream issue #957.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** Detect whether podman is available, preferring it over docker. */
function detectRuntime(): string {
  try {
    execSync('podman --version', { stdio: 'pipe' });
    logger.info('Detected container runtime: podman');
    return 'podman';
  } catch {
    // podman not found, fall back to docker
    return 'docker';
  }
}

/** The container runtime binary name (podman preferred, docker fallback). */
export const CONTAINER_RUNTIME_BIN = detectRuntime();

/** Whether we are using Podman as the container runtime. */
export const IS_PODMAN = CONTAINER_RUNTIME_BIN === 'podman';

/**
 * Hostname containers use to reach the host machine.
 * Podman uses host.containers.internal; Docker uses host.docker.internal.
 */
export const CONTAINER_HOST_GATEWAY = IS_PODMAN
  ? 'host.containers.internal'
  : 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 * Podman: daemonless; agents reach the proxy via host.containers.internal,
 *   which requires binding on all interfaces (0.0.0.0).
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  // Podman is daemonless — no docker0 bridge.
  // host.containers.internal resolves to the host, but only if we listen on 0.0.0.0.
  if (IS_PODMAN) return '0.0.0.0';

  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Podman has host.containers.internal built-in — no extra args needed.
  if (IS_PODMAN) return [];

  // On Linux with Docker, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/**
 * SELinux mount suffix for writable bind mounts.
 * Fedora/RHEL enable SELinux by default; Podman volume mounts need :z so the
 * container process (container_t) can read/write them.
 * /dev/ paths are excluded (cannot relabel device nodes).
 * Harmless on non-SELinux systems.
 */
export function writableMountSuffix(hostPath?: string): string {
  if (!IS_PODMAN) return '';
  // /dev/ paths cannot be relabeled
  if (hostPath && hostPath.startsWith('/dev/')) return '';
  return ':z';
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  const suffix = IS_PODMAN && !hostPath.startsWith('/dev/') ? ',z' : '';
  return ['-v', `${hostPath}:${containerPath}:ro${suffix}`];
}

/**
 * Podman user namespace args.
 * --userns=keep-id maps the host user's UID into the container so bind-mounted
 * files have correct ownership. This replaces Docker's --user UID:GID approach,
 * which fails under rootless Podman with large UIDs (setgroups error).
 */
export function userNamespaceArgs(): string[] {
  if (IS_PODMAN) {
    return ['--userns=keep-id'];
  }
  return [];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      `║  1. Ensure ${IS_PODMAN ? 'Podman' : 'Docker'} is installed and running${' '.repeat(IS_PODMAN ? 18 : 18)}║`,
    );
    console.error(
      `║  2. Run: ${CONTAINER_RUNTIME_BIN} info${' '.repeat(46 - CONTAINER_RUNTIME_BIN.length)}║`,
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
