import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import http from 'http';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'BrAIn',
  TRIGGER_PATTERN: /^@BrAIn\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    GATEWAY_URL: 'http://localhost:18080',
    GATEWAY_SECRET: 'test-secret',
    GATEWAY_AGENT_ID: 'test-agent',
    GATEWAY_AGENT_NAME: 'BrAIn',
    GATEWAY_OWNER_SLACK_ID: 'U07J3K6KS1K',
    GATEWAY_LISTEN_PORT: '0', // Use port 0 for random available port
    GATEWAY_CHANNELS: 'C0AJNU16ZGX,C09CK9093LH',
  }),
}));

import { GatewayChannel, GatewayChannelOpts } from './gateway.js';
import { registerChannel } from './registry.js';

// Capture the module-level registerChannel call before any beforeEach clears mocks
const initialRegistrationCalls = (
  registerChannel as ReturnType<typeof vi.fn>
).mock.calls.slice();

// --- Helpers ---

function createTestOpts(
  overrides?: Partial<GatewayChannelOpts>,
): GatewayChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0AJNU16ZGX': {
        name: 'brain',
        folder: 'slack_brain',
        trigger: '@BrAIn',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...extraHeaders,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(responseBody),
            });
          } catch {
            resolve({ status: res.statusCode!, body: responseBody });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Tests ---

describe('GatewayChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetch globally
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
      json: () => Promise.resolve({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('self-registration', () => {
    it('registers with the channel registry', () => {
      expect(initialRegistrationCalls).toContainEqual([
        'gateway',
        expect.any(Function),
      ]);
    });

    it('factory returns null when GATEWAY_URL is not set', async () => {
      const { readEnvFile } = await import('../env.js');
      (readEnvFile as ReturnType<typeof vi.fn>).mockReturnValueOnce({});

      const factory = initialRegistrationCalls[0][1];
      const channel = factory({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn(() => ({})),
      });
      expect(channel).toBeNull();
    });
  });

  describe('construction', () => {
    it('creates without throwing', () => {
      const opts = createTestOpts();
      const channel = new GatewayChannel(opts);
      expect(channel.name).toBe('gateway');
    });
  });

  describe('ownsJid', () => {
    it('owns configured channel JIDs', () => {
      const channel = new GatewayChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0AJNU16ZGX')).toBe(true);
      expect(channel.ownsJid('slack:C09CK9093LH')).toBe(true);
    });

    it('owns DM JIDs (D-prefix)', () => {
      const channel = new GatewayChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own unknown channel JIDs', () => {
      const channel = new GatewayChannel(createTestOpts());
      expect(channel.ownsJid('slack:CUNKNOWN')).toBe(false);
    });
  });

  describe('message receiving', () => {
    let channel: GatewayChannel;
    let opts: GatewayChannelOpts;
    let serverPort: number;

    beforeEach(async () => {
      opts = createTestOpts();
      channel = new GatewayChannel(opts);

      // Mock register to succeed
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{}'),
      });

      await channel.connect();

      // Get the actual port the server is listening on
      const server = (channel as any).server as http.Server;
      const addr = server.address();
      serverPort =
        typeof addr === 'object' && addr ? addr.port : 0;
    });

    afterEach(async () => {
      await channel.disconnect();
    });

    const authHeaders = { Authorization: 'Bearer test-secret' };

    it('rejects unauthenticated requests with 401', async () => {
      const msg = {
        channel: 'C0AJNU16ZGX',
        isDm: false,
        messageTs: '1234567890.000000',
        senderUserId: 'U07J3K6KS1K',
        senderName: 'Bryan',
        text: 'no auth',
        timestamp: '2026-03-16T19:00:00.000Z',
        isBot: false,
      };

      const resp = await postJson(serverPort, '/message', msg);
      expect(resp.status).toBe(401);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects requests with wrong secret', async () => {
      const msg = {
        channel: 'C0AJNU16ZGX',
        isDm: false,
        messageTs: '1234567890.000000',
        senderUserId: 'U07J3K6KS1K',
        senderName: 'Bryan',
        text: 'wrong secret',
        timestamp: '2026-03-16T19:00:00.000Z',
        isBot: false,
      };

      const resp = await postJson(serverPort, '/message', msg, {
        Authorization: 'Bearer wrong-secret',
      });
      expect(resp.status).toBe(401);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('accepts forwarded messages on POST /message', async () => {
      const msg = {
        channel: 'C0AJNU16ZGX',
        isDm: false,
        messageTs: '1234567890.123456',
        senderUserId: 'U07J3K6KS1K',
        senderName: 'Bryan Lozano',
        text: 'Hello BrAIn',
        timestamp: '2026-03-16T19:00:00.000Z',
        isBot: false,
      };

      const resp = await postJson(serverPort, '/message', msg, authHeaders);
      expect(resp.status).toBe(200);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0AJNU16ZGX',
        expect.objectContaining({
          id: '1234567890.123456',
          chat_jid: 'slack:C0AJNU16ZGX',
          sender: 'U07J3K6KS1K',
          sender_name: 'Bryan Lozano',
          content: 'Hello BrAIn',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('emits chat metadata', async () => {
      const msg = {
        channel: 'C0AJNU16ZGX',
        channelName: 'brain',
        isDm: false,
        messageTs: '1234567890.123456',
        senderUserId: 'U07J3K6KS1K',
        senderName: 'Bryan',
        text: 'test',
        timestamp: '2026-03-16T19:00:00.000Z',
        isBot: false,
      };

      await postJson(serverPort, '/message', msg, authHeaders);
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0AJNU16ZGX',
        '2026-03-16T19:00:00.000Z',
        'brain',
        'slack',
        true, // isGroup = !isDm
      );
    });

    it('sets thread_id from threadTs when present', async () => {
      const msg = {
        channel: 'C0AJNU16ZGX',
        isDm: false,
        threadTs: '1234567890.000000',
        messageTs: '1234567891.123456',
        senderUserId: 'U07J3K6KS1K',
        senderName: 'Bryan',
        text: 'threaded reply',
        timestamp: '2026-03-16T19:00:00.000Z',
        isBot: false,
      };

      await postJson(serverPort, '/message', msg, authHeaders);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0AJNU16ZGX',
        expect.objectContaining({
          thread_id: '1234567890.000000',
        }),
      );
    });

    it('uses messageTs as thread_id for top-level messages', async () => {
      const msg = {
        channel: 'C0AJNU16ZGX',
        isDm: false,
        messageTs: '1234567890.123456',
        senderUserId: 'U07J3K6KS1K',
        senderName: 'Bryan',
        text: 'top-level message',
        timestamp: '2026-03-16T19:00:00.000Z',
        isBot: false,
      };

      await postJson(serverPort, '/message', msg, authHeaders);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0AJNU16ZGX',
        expect.objectContaining({
          thread_id: '1234567890.123456',
        }),
      );
    });

    it('returns 200 on /health', async () => {
      const resp = await new Promise<number>((resolve, reject) => {
        http
          .get(`http://localhost:${serverPort}/health`, (res) => {
            resolve(res.statusCode!);
          })
          .on('error', reject);
      });
      expect(resp).toBe(200);
    });

    it('returns 404 on unknown paths', async () => {
      const resp = await postJson(serverPort, '/unknown', {});
      expect(resp.status).toBe(404);
    });
  });

  describe('sendMessage', () => {
    let channel: GatewayChannel;

    beforeEach(async () => {
      channel = new GatewayChannel(createTestOpts());
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{}'),
      });
      await channel.connect();
    });

    afterEach(async () => {
      await channel.disconnect();
    });

    it('posts response to gateway /respond endpoint', async () => {
      await channel.sendMessage('slack:C0AJNU16ZGX', 'Hello!');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:18080/respond',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-secret',
          }),
        }),
      );

      // Parse the body
      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: any[]) => c[0].includes('/respond'),
      );
      const body = JSON.parse(call![1].body);
      expect(body.channel).toBe('C0AJNU16ZGX');
      expect(body.text).toBe('Hello!');
    });
  });

  describe('registration', () => {
    it('calls gateway /register on connect', async () => {
      const channel = new GatewayChannel(createTestOpts());
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{}'),
      });

      await channel.connect();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:18080/register',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-secret',
          }),
        }),
      );

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: any[]) => c[0].includes('/register'),
      );
      const body = JSON.parse(call![1].body);
      expect(body.id).toBe('test-agent');
      expect(body.ownerSlackId).toBe('U07J3K6KS1K');
      expect(body.channels).toEqual(['C0AJNU16ZGX', 'C09CK9093LH']);

      await channel.disconnect();
    });

    it('calls gateway /unregister on disconnect', async () => {
      const channel = new GatewayChannel(createTestOpts());
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{}'),
      });

      await channel.connect();
      (global.fetch as ReturnType<typeof vi.fn>).mockClear();

      await channel.disconnect();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:18080/unregister',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'test-agent' }),
        }),
      );
    });
  });
});
