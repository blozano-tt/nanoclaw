import http from 'http';
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  SendMessageOpts,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// ----- Types for gateway protocol -----

/** Message forwarded from gateway to this NanoClaw instance */
interface ForwardedMessage {
  channel: string;
  channelName?: string;
  isDm: boolean;
  threadTs?: string;
  messageTs: string;
  senderUserId: string;
  senderName: string;
  text: string;
  timestamp: string;
  isBot: boolean;
}

// ----- Configuration -----

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute
const REGISTER_RETRY_INTERVAL_MS = 10_000; // 10 seconds
const REGISTER_MAX_RETRIES = 30; // 5 minutes of retrying

export interface GatewayChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * GatewayChannel connects this NanoClaw instance to a BrAIn Gateway.
 *
 * Instead of holding a direct Slack Socket Mode connection, this channel:
 * 1. Starts a local HTTP server to receive forwarded messages from the gateway
 * 2. Registers with the gateway (providing this server's endpoint)
 * 3. Sends heartbeats to stay marked as healthy
 * 4. Posts responses back to the gateway via HTTP, which relays them to Slack
 *
 * This enables multi-user deployments where a single Slack app + gateway
 * routes messages to many NanoClaw instances on different VMs.
 */
export class GatewayChannel implements Channel {
  name = 'gateway';

  private gatewayUrl: string;
  private gatewaySecret: string;
  private agentId: string;
  private agentName: string;
  private ownerSlackId: string;
  /** When set, only this Slack user id is stored as is_bot_message (our app bot). */
  private slackBotUserId: string;
  private listenPort: number;
  private channels: string[];

  private server: http.Server | null = null;
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private opts: GatewayChannelOpts;

  // Track thread context for replies (messageTs → threadTs)
  private messageThreadTarget = new Map<string, string>();
  private fallbackThreadTs = new Map<string, string>();
  private static readonly MAX_THREAD_MAP_SIZE = 2000;

  constructor(opts: GatewayChannelOpts) {
    this.opts = opts;

    const env = readEnvFile([
      'GATEWAY_URL',
      'GATEWAY_SECRET',
      'GATEWAY_AGENT_ID',
      'GATEWAY_AGENT_NAME',
      'GATEWAY_OWNER_SLACK_ID',
      'GATEWAY_SLACK_BOT_USER_ID',
      'GATEWAY_LISTEN_PORT',
      'GATEWAY_CHANNELS',
    ]);

    this.gatewayUrl = env.GATEWAY_URL || '';
    this.gatewaySecret = env.GATEWAY_SECRET || '';
    this.agentId = env.GATEWAY_AGENT_ID || '';
    this.agentName = env.GATEWAY_AGENT_NAME || ASSISTANT_NAME;
    this.ownerSlackId = env.GATEWAY_OWNER_SLACK_ID || '';
    this.slackBotUserId = (env.GATEWAY_SLACK_BOT_USER_ID || '').trim();
    this.listenPort = parseInt(env.GATEWAY_LISTEN_PORT || '9090', 10);
    this.channels = (env.GATEWAY_CHANNELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async connect(): Promise<void> {
    // Start local HTTP server to receive forwarded messages
    await this.startServer();

    // Register with the gateway
    await this.registerWithRetry();

    // Start heartbeats
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );

    this.connected = true;

    logger.info(
      {
        gatewayUrl: this.gatewayUrl,
        agentId: this.agentId,
        listenPort: this.listenPort,
        channels: this.channels,
      },
      'Connected to BrAIn Gateway',
    );
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    // Determine thread context
    const channelId = jid.replace(/^slack:/, '');
    let threadTs: string | undefined;

    if (opts?.replyTo) {
      threadTs = this.messageThreadTarget.get(opts.replyTo);
    }
    if (!threadTs) {
      threadTs = this.fallbackThreadTs.get(jid);
    }

    // Post response back to the gateway
    const url = `${this.gatewayUrl}/respond`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.gatewaySecret}`,
        },
        body: JSON.stringify({
          channel: channelId,
          threadTs,
          text,
        }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        logger.error(
          { status: resp.status, body, jid },
          'Gateway rejected response',
        );
        return;
      }

      logger.info(
        { jid, length: text.length, thread: !!threadTs },
        'Response sent via gateway',
      );
    } catch (err) {
      logger.error({ err, jid, url }, 'Failed to send response to gateway');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // The gateway channel owns any JID for channels it's registered for,
    // plus DM JIDs (which the gateway routes by owner)
    const channelId = jid.replace(/^slack:/, '');
    if (this.channels.includes(channelId)) return true;

    // For DM channels (D-prefix), we own if we're the gateway channel
    if (channelId.startsWith('D')) return true;

    return false;
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Unregister from gateway (best effort)
    try {
      await fetch(`${this.gatewayUrl}/unregister`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.gatewaySecret}`,
        },
        body: JSON.stringify({ id: this.agentId }),
      });
    } catch {
      // Best effort
    }

    logger.info('Disconnected from BrAIn Gateway');
  }

  // ----- Private methods -----

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/message') {
          if (!this.authenticateRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
          this.handleIncomingMessage(req, res);
        } else if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.on('error', (err) => {
        logger.error({ err, port: this.listenPort }, 'Gateway listener error');
        reject(err);
      });

      this.server.listen(this.listenPort, '0.0.0.0', () => {
        logger.info(
          { port: this.listenPort },
          'Gateway message listener started',
        );
        resolve();
      });
    });
  }

  private authenticateRequest(req: http.IncomingMessage): boolean {
    const authHeader = req.headers['authorization'] || '';
    const expected = `Bearer ${this.gatewaySecret}`;
    if (!this.gatewaySecret || authHeader !== expected) {
      logger.warn(
        { url: req.url, remoteAddr: req.socket.remoteAddress },
        'Rejected unauthenticated request to gateway listener',
      );
      return false;
    }
    return true;
  }

  private handleIncomingMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const msg: ForwardedMessage = JSON.parse(body);
        this.processForwardedMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        logger.error({ err }, 'Failed to parse forwarded message');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid message' }));
      }
    });
  }

  private processForwardedMessage(msg: ForwardedMessage): void {
    const jid = `slack:${msg.channel}`;
    const timestamp = msg.timestamp;

    // Track thread context
    const replyTarget = msg.threadTs || msg.messageTs;
    this.messageThreadTarget.set(msg.messageTs, replyTarget);
    this.fallbackThreadTs.set(jid, replyTarget);
    this.evictOldThreadTargets();

    // Emit chat metadata
    this.opts.onChatMetadata(
      jid,
      timestamp,
      msg.channelName,
      'slack',
      !msg.isDm,
    );

    const isOurBotMessage =
      msg.isBot &&
      this.slackBotUserId !== '' &&
      msg.senderUserId === this.slackBotUserId;

    // Emit the message
    this.opts.onMessage(jid, {
      id: msg.messageTs,
      chat_jid: jid,
      sender: msg.senderUserId,
      sender_name: msg.senderName,
      content: msg.text,
      timestamp,
      is_from_me: false, // Gateway never forwards our own messages
      is_bot_message: isOurBotMessage,
      thread_id: replyTarget,
    });

    logger.debug(
      {
        channel: msg.channel,
        sender: msg.senderName,
        isDm: msg.isDm,
        hasThread: !!msg.threadTs,
      },
      'Forwarded message received from gateway',
    );
  }

  private async registerWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < REGISTER_MAX_RETRIES; attempt++) {
      try {
        await this.register();
        return;
      } catch (err) {
        logger.warn(
          { err, attempt, maxRetries: REGISTER_MAX_RETRIES },
          'Gateway registration failed, retrying...',
        );
        await new Promise((r) => setTimeout(r, REGISTER_RETRY_INTERVAL_MS));
      }
    }
    throw new Error(
      `Failed to register with gateway after ${REGISTER_MAX_RETRIES} attempts`,
    );
  }

  private async register(): Promise<void> {
    // Determine our externally reachable endpoint
    // The gateway needs to reach us — use hostname or IP
    const hostname =
      process.env.GATEWAY_EXTERNAL_HOST ||
      (await this.getHostname());

    const endpoint = `http://${hostname}:${this.listenPort}`;

    const resp = await fetch(`${this.gatewayUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.gatewaySecret}`,
      },
      body: JSON.stringify({
        id: this.agentId,
        name: this.agentName,
        endpoint,
        ownerSlackId: this.ownerSlackId,
        channels: this.channels,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Registration failed: ${resp.status} ${body}`);
    }

    logger.info(
      { agentId: this.agentId, endpoint },
      'Registered with gateway',
    );
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const resp = await fetch(`${this.gatewayUrl}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.gatewaySecret}`,
        },
        body: JSON.stringify({ id: this.agentId }),
      });

      if (!resp.ok) {
        logger.warn(
          { status: resp.status },
          'Gateway heartbeat failed',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Gateway heartbeat error');
    }
  }

  private async getHostname(): Promise<string> {
    // Try to get the machine's hostname
    const { hostname } = await import('os');
    return hostname();
  }

  private evictOldThreadTargets(): void {
    if (
      this.messageThreadTarget.size <= GatewayChannel.MAX_THREAD_MAP_SIZE
    ) {
      return;
    }
    const excess =
      this.messageThreadTarget.size - GatewayChannel.MAX_THREAD_MAP_SIZE;
    const iter = this.messageThreadTarget.keys();
    for (let i = 0; i < excess; i++) {
      const key = iter.next().value;
      if (key) this.messageThreadTarget.delete(key);
    }
    logger.debug(
      { evicted: excess, remaining: this.messageThreadTarget.size },
      'Evicted old gateway thread target entries',
    );
  }
}

// ----- Self-registration -----

registerChannel('gateway', (opts: ChannelOpts) => {
  const env = readEnvFile(['GATEWAY_URL', 'GATEWAY_SECRET']);
  if (!env.GATEWAY_URL || !env.GATEWAY_SECRET) {
    return null; // Gateway not configured — skip
  }

  return new GatewayChannel({
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
  });
});
