import http from 'http';
import https from 'https';
import fs from 'fs';
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

// ----- TLS helpers -----

interface TlsConfig {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

function loadTlsConfig(env: Record<string, string>): TlsConfig | null {
  const certPath = env.GATEWAY_TLS_CERT;
  const keyPath = env.GATEWAY_TLS_KEY;
  const caPath = env.GATEWAY_TLS_CA;

  if (!certPath || !keyPath || !caPath) return null;

  try {
    const config = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      ca: fs.readFileSync(caPath),
    };
    logger.info(
      { cert: certPath, key: keyPath, ca: caPath },
      'mTLS certificates loaded for gateway channel',
    );
    return config;
  } catch (err) {
    logger.error({ err }, 'Failed to load mTLS certificates');
    return null;
  }
}

/**
 * GatewayChannel connects this NanoClaw instance to a BrAIn Gateway.
 *
 * Instead of holding a direct Slack Socket Mode connection, this channel:
 * 1. Starts a local HTTP(S) server to receive forwarded messages from the gateway
 * 2. Registers with the gateway (providing this server's endpoint)
 * 3. Sends heartbeats to stay marked as healthy
 * 4. Posts responses back to the gateway via HTTP(S), which relays them to Slack
 *
 * When TLS certificates are configured (GATEWAY_TLS_CERT, GATEWAY_TLS_KEY,
 * GATEWAY_TLS_CA), all connections use mTLS for mutual authentication.
 */
export class GatewayChannel implements Channel {
  name = 'gateway';

  private gatewayUrl: string;
  private gatewaySecret: string;
  private agentId: string;
  private agentName: string;
  private ownerSlackId: string;
  private ownerEmail: string;
  /** When set, only this Slack user id is stored as is_bot_message (our app bot). */
  private slackBotUserId: string;
  private listenPort: number;
  private channels: string[];
  private allowedUsers: string[];
  private allowedEmails: string[];

  private tlsConfig: TlsConfig | null;
  private tlsAgent: https.Agent | null = null;

  private server: http.Server | https.Server | null = null;
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
      'GATEWAY_OWNER_EMAIL',
      'GATEWAY_SLACK_BOT_USER_ID',
      'GATEWAY_LISTEN_PORT',
      'GATEWAY_CHANNELS',
      'GATEWAY_ALLOWED_USERS',
      'GATEWAY_ALLOWED_EMAILS',
      'GATEWAY_TLS_CERT',
      'GATEWAY_TLS_KEY',
      'GATEWAY_TLS_CA',
    ]);

    this.gatewayUrl = env.GATEWAY_URL || '';
    this.gatewaySecret = env.GATEWAY_SECRET || '';
    this.agentId = env.GATEWAY_AGENT_ID || '';
    this.agentName = env.GATEWAY_AGENT_NAME || ASSISTANT_NAME;
    this.ownerSlackId = env.GATEWAY_OWNER_SLACK_ID || '';
    this.ownerEmail = env.GATEWAY_OWNER_EMAIL || '';
    this.slackBotUserId = (env.GATEWAY_SLACK_BOT_USER_ID || '').trim();
    this.listenPort = parseInt(env.GATEWAY_LISTEN_PORT || '9090', 10);
    this.channels = (env.GATEWAY_CHANNELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.allowedUsers = (env.GATEWAY_ALLOWED_USERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.allowedEmails = (env.GATEWAY_ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Load TLS config if all three paths are set
    this.tlsConfig = loadTlsConfig(env);

    if (this.tlsConfig) {
      this.tlsAgent = new https.Agent({
        cert: this.tlsConfig.cert,
        key: this.tlsConfig.key,
        ca: this.tlsConfig.ca,
        rejectUnauthorized: true,
      });
    }
  }

  async connect(): Promise<void> {
    // Start local HTTP(S) server to receive forwarded messages
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
        tls: !!this.tlsConfig,
      },
      'Connected to BrAIn Gateway',
    );
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<void> {
    // Determine thread context — precedence:
    // 1. Explicit threadId (caller knows the thread)
    // 2. Lookup by specific message ID (replyTo)
    // 3. Per-channel fallback (last resort, may be stale with concurrent threads)
    const channelId = jid.replace(/^slack:/, '');
    let threadTs: string | undefined;

    if (opts?.threadId) {
      threadTs = opts.threadId;
    }
    if (!threadTs && opts?.replyTo) {
      threadTs = this.messageThreadTarget.get(opts.replyTo);
    }
    if (!threadTs) {
      threadTs = this.fallbackThreadTs.get(jid);
    }

    // Post response back to the gateway
    const url = `${this.gatewayUrl}/respond`;

    try {
      const resp = await this.tlsFetch(url, {
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
        { jid, length: text.length, thread: !!threadTs, threadTs },
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
      await this.tlsFetch(`${this.gatewayUrl}/unregister`, {
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

    if (this.tlsAgent) {
      this.tlsAgent.destroy();
      this.tlsAgent = null;
    }

    logger.info('Disconnected from BrAIn Gateway');
  }

  // ----- Private methods -----

  /**
   * Fetch wrapper that uses mTLS when certificates are configured.
   * Falls back to plain fetch when TLS is not enabled.
   */
  private async tlsFetch(url: string, init: RequestInit): Promise<Response> {
    if (!this.tlsAgent) {
      return fetch(url, init);
    }

    // Use https.request with client cert for mTLS
    return new Promise<Response>((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: init.method || 'GET',
          headers: init.headers as Record<string, string>,
          agent: this.tlsAgent!,
          timeout: 10_000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            resolve({
              ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
              status: res.statusCode || 0,
              statusText: res.statusMessage || '',
              text: () => Promise.resolve(body),
              json: () => Promise.resolve(JSON.parse(body)),
              headers: new Headers(),
            } as Response);
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });

      if (init.body) {
        req.write(init.body);
      }
      req.end();
    });
  }

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ): void => {
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
      };

      if (this.tlsConfig) {
        // mTLS server: require and verify client certificates
        this.server = https.createServer(
          {
            cert: this.tlsConfig.cert,
            key: this.tlsConfig.key,
            ca: this.tlsConfig.ca,
            requestCert: true,
            rejectUnauthorized: true,
          },
          handler,
        );
        logger.info('Gateway listener using mTLS');
      } else {
        this.server = http.createServer(handler);
      }

      this.server.on('error', (err) => {
        logger.error({ err, port: this.listenPort }, 'Gateway listener error');
        reject(err);
      });

      this.server.listen(this.listenPort, '0.0.0.0', () => {
        logger.info(
          { port: this.listenPort, tls: !!this.tlsConfig },
          `Gateway message listener started (${this.tlsConfig ? 'mTLS' : 'HTTP'})`,
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

    // is_bot_message must mean "our assistant bot", not every Slack bot.
    // Slack sets isBot for third-party apps (alerts, CI); those still need to flow
    // to the agent. Only exclude messages from this app's bot user when
    // GATEWAY_SLACK_BOT_USER_ID matches (gateway may echo them in edge cases).
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
      process.env.GATEWAY_EXTERNAL_HOST || (await this.getHostname());

    const protocol = this.tlsConfig ? 'https' : 'http';
    const endpoint = `${protocol}://${hostname}:${this.listenPort}`;

    // Build registration payload.
    // Email-based identity is preferred; Slack IDs are sent as fallback.
    // The Gateway resolves emails → Slack IDs on its side.
    const payload: Record<string, unknown> = {
      id: this.agentId,
      name: this.agentName,
      endpoint,
      channels: this.channels,
    };

    // Owner identity: prefer email, fall back to Slack ID
    if (this.ownerEmail) {
      payload.ownerEmail = this.ownerEmail;
    }
    if (this.ownerSlackId) {
      payload.ownerSlackId = this.ownerSlackId;
    }

    // Allowed users: prefer emails, fall back to Slack IDs
    if (this.allowedEmails.length > 0) {
      payload.allowedEmails = this.allowedEmails;
    }
    if (this.allowedUsers.length > 0) {
      payload.allowedUsers = this.allowedUsers;
    }

    const resp = await this.tlsFetch(`${this.gatewayUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.gatewaySecret}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Registration failed: ${resp.status} ${body}`);
    }

    logger.info(
      { agentId: this.agentId, endpoint, ownerEmail: this.ownerEmail || undefined },
      'Registered with gateway',
    );
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const resp = await this.tlsFetch(`${this.gatewayUrl}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.gatewaySecret}`,
        },
        body: JSON.stringify({ id: this.agentId }),
      });

      if (!resp.ok) {
        logger.warn({ status: resp.status }, 'Gateway heartbeat failed');
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
    if (this.messageThreadTarget.size <= GatewayChannel.MAX_THREAD_MAP_SIZE) {
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
