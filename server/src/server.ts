/**
 * Minimal Node http server exposing POST /api/ask. Streams OpenAI chat
 * completions as SSE back to the browser widget. CORS allow-list and
 * per-IP rate limiting included. No external web framework.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { streamChat, UpstreamError, type OpenAIMessage } from './openai.js';
import { TokenBucket } from './rate-limit.js';
import { pinSystemPrompt, resolveUpstream, type UpstreamConfig } from './upstream.js';

// Load .env from server/ first, then fall back to monorepo root.
const here = dirname(fileURLToPath(import.meta.url));
for (const p of [
  resolve(here, '../.env'),
  resolve(here, '../../.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(p)) {
    loadEnv({ path: p });
    break;
  }
}

const MAX_BODY = 32 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 4000;

interface ProxyConfig {
  upstream: UpstreamConfig;
  askToken: string;
  systemPrompt: string | undefined;
  allowed: string[];
  trustProxy: boolean;
  limiter: TokenBucket;
}

export function createProxyServer(env: Record<string, string | undefined> = process.env): Server {
  const rpm = Number(env.RATE_LIMIT_RPM ?? 20);
  const config: ProxyConfig = {
    upstream: resolveUpstream(env),
    askToken: env.ASK_TOKEN ?? '',
    systemPrompt: env.SYSTEM_PROMPT,
    allowed: (env.ALLOWED_ORIGINS ?? '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
    limiter: new TokenBucket(Number.isFinite(rpm) && rpm > 0 ? rpm : 20, (Number.isFinite(rpm) && rpm > 0 ? rpm : 20) / 60),
  };
  return createServer((req, res) => handle(req, res, config));
}

function originAllowed(origin: string | undefined, allowed: string[]): string | null {
  if (!origin) return null;
  if (allowed.includes('*')) return '*';
  return allowed.includes(origin) ? origin : null;
}

function setCors(req: IncomingMessage, res: ServerResponse, allowed: string[]): boolean {
  const origin = req.headers.origin as string | undefined;
  const ok = originAllowed(origin, allowed);
  if (origin && !ok) {
    sendJsonError(res, 403, 'origin not allowed', 'forbidden');
    return false;
  }
  if (ok) res.setHeader('access-control-allow-origin', ok);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-mascot-token');
  res.setHeader('access-control-max-age', '86400');
  return true;
}

/**
 * Every error response — CORS rejection, 404, rate limit, missing config,
 * bad request — uses this single `{ error, kind }` JSON envelope so the
 * widget never has to guess whether a body is plain text or JSON.
 */
function sendJsonError(
  res: ServerResponse,
  status: number,
  error: string,
  kind: string,
  headers?: Record<string, string>,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  if (headers) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  }
  res.end(JSON.stringify({ error, kind }));
}

function tokenOk(header: string | undefined, askToken: string): boolean {
  if (!askToken) return true;
  const got = Buffer.from(header ?? '');
  const expect = Buffer.from(askToken);
  if (got.length !== expect.length) {
    timingSafeEqual(expect, expect);
    return false;
  }
  return timingSafeEqual(got, expect);
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let total = 0;
    let tooLarge = false;
    let settled = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('request body timeout'));
      req.destroy();
    }, BODY_TIMEOUT_MS);
    req.on('data', (c: Buffer) => {
      total += c.length;
      // Keep reading so the client can receive 413. Bytes past the cap are dropped.
      if (total > MAX_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tooLarge) reject(new Error('payload too large'));
      else resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

function sse(res: ServerResponse): void {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
}

function sseSend(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res: ServerResponse): void {
  res.write(`data: [DONE]\n\n`);
  res.end();
}

function validateMessages(input: unknown): OpenAIMessage[] {
  if (!Array.isArray(input)) throw new Error('messages must be an array');
  if (input.length === 0) throw new Error('messages cannot be empty');
  if (input.length > MAX_MESSAGES) throw new Error('too many messages');
  return input.map((m, i) => {
    if (!m || typeof m !== 'object') throw new Error(`messages[${i}] not object`);
    const role = (m as { role: unknown }).role;
    const content = (m as { content: unknown }).content;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new Error(`messages[${i}].role invalid`);
    }
    if (typeof content !== 'string' || !content) {
      throw new Error(`messages[${i}].content invalid`);
    }
    if (content.length > MAX_CONTENT) {
      throw new Error(`messages[${i}].content exceeds ${MAX_CONTENT} chars`);
    }
    return { role, content };
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: ProxyConfig): Promise<void> {
  const { upstream } = config;
  if (!setCors(req, res, config.allowed)) return;
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, model: upstream.model }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/ask') {
    sendJsonError(res, 404, 'not found', 'not_found');
    return;
  }

  if (!upstream.apiKey) {
    sendJsonError(
      res,
      503,
      'server is missing an API key — the assistant is not configured',
      'unauthorized',
    );
    return;
  }

  const ip = clientIp(req, config.trustProxy);
  if (!config.limiter.take(ip)) {
    sendJsonError(res, 429, 'rate limit exceeded', 'rate_limit', {
      'retry-after': String(config.limiter.retryAfter(ip)),
    });
    return;
  }

  const provided = req.headers['x-mascot-token'];
  const headerToken = Array.isArray(provided) ? provided[0] : provided;
  if (!tokenOk(headerToken, config.askToken)) {
    sendJsonError(res, 401, 'missing or invalid token', 'unauthorized');
    return;
  }

  let messages: OpenAIMessage[];
  try {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { messages?: unknown };
    messages = pinSystemPrompt(validateMessages(parsed.messages), config.systemPrompt);
  } catch (e) {
    if (!res.writableEnded) {
      const tooLarge = (e as Error).message === 'payload too large';
      const message = e instanceof SyntaxError ? 'request body must be JSON' : (e as Error).message;
      sendJsonError(res, tooLarge ? 413 : 400, message, 'bad_request');
    }
    return;
  }

  sse(res);

  const ac = new AbortController();
  let clientClosed = false;
  let timedOut = false;
  let settled = false;
  const armStall = (): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, upstream.timeoutMs);
  let stall = armStall();
  const onResClose = (): void => {
    if (settled || res.writableFinished) return;
    clientClosed = true;
    clearTimeout(stall);
    ac.abort();
  };
  res.on('close', onResClose);

  try {
    for await (const delta of streamChat({
      apiKey: upstream.apiKey,
      model: upstream.model,
      messages,
      signal: ac.signal,
      baseUrl: upstream.baseUrl,
      maxTokens: upstream.maxTokens,
      maxTokenField: upstream.maxTokenField,
    })) {
      clearTimeout(stall);
      stall = armStall();
      sseSend(res, { delta });
    }
    settled = true;
    sseDone(res);
  } catch (e) {
    clearTimeout(stall);
    // If the client already disconnected, don't attempt to write to the
    // destroyed socket — it's pointless and would throw.
    if (clientClosed || res.writableEnded) return;
    settled = true;
    if (timedOut) {
      sseSend(res, { error: 'upstream timed out', kind: 'timeout' });
      sseDone(res);
      return;
    }
    const kind = e instanceof UpstreamError ? e.kind : 'server';
    const error =
      kind === 'unauthorized'
        ? 'upstream rejected the API key'
        : kind === 'rate_limit'
          ? 'upstream rate limit'
          : 'upstream request failed';
    sseSend(res, { error, kind });
    sseDone(res);
  } finally {
    clearTimeout(stall);
    res.off('close', onResClose);
  }
}

export function startProxy(env: Record<string, string | undefined> = process.env): Server {
  const upstream = resolveUpstream(env);
  if (!upstream.apiKey) {
    console.warn('⚠ no API key set — /api/ask will return 503.');
  }
  const port = Number(env.PORT ?? 8787);
  const server = createProxyServer(env);
  server.listen(port, () => {
    const askToken = env.ASK_TOKEN ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const rpm = Number(env.RATE_LIMIT_RPM ?? 20);
    console.log(`mascot proxy listening on http://localhost:${port}`);
    console.log(`  model:           ${upstream.model}`);
    console.log(`  upstream:        ${upstream.baseUrl}`);
    console.log(`  allowed origins: ${allowed.join(', ') || '(none)'}`);
    console.log(`  rate limit:      ${rpm} req/min/ip`);
    console.log(`  ask token:       ${askToken ? 'required' : 'off'}`);
  });
  return server;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) startProxy();
