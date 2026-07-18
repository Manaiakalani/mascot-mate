/**
 * Minimal Node http server exposing POST /api/ask. Streams OpenAI chat
 * completions as SSE back to the browser widget. CORS allow-list and
 * per-IP rate limiting included. No external web framework.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { streamChat, type OpenAIMessage } from './openai.js';
import { TokenBucket } from './rate-limit.js';

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

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const KEY = process.env.OPENAI_API_KEY ?? '';
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RPM = Number(process.env.RATE_LIMIT_RPM ?? 20);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_BODY = 32 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 4000;

if (!KEY) {
  console.warn('⚠ OPENAI_API_KEY not set — /api/ask will return 500.');
}

const limiter = new TokenBucket(RPM, RPM / 60);

function originAllowed(origin: string | undefined): string | null {
  if (!origin) return null;
  if (ALLOWED.includes('*')) return '*';
  return ALLOWED.includes(origin) ? origin : null;
}

function setCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin as string | undefined;
  const allowed = originAllowed(origin);
  if (origin && !allowed) {
    sendJsonError(res, 403, 'origin not allowed', 'forbidden');
    return false;
  }
  if (allowed) res.setHeader('access-control-allow-origin', allowed);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
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

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
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
      if (total > MAX_BODY) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('payload too large'));
        }
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
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

const server = createServer(async (req, res) => {
  if (!setCors(req, res)) return;
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, model: MODEL }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/ask') {
    sendJsonError(res, 404, 'not found', 'not_found');
    return;
  }

  const ip = clientIp(req);
  if (!limiter.take(ip)) {
    sendJsonError(res, 429, 'rate limit exceeded', 'rate_limit', { 'retry-after': '5' });
    return;
  }

  if (!KEY) {
    sendJsonError(
      res,
      503,
      'server is missing OPENAI_API_KEY — the assistant is not configured',
      'unauthorized',
    );
    return;
  }

  let messages: OpenAIMessage[];
  try {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { messages?: unknown };
    messages = validateMessages(parsed.messages);
  } catch (e) {
    if (!res.writableEnded) {
      sendJsonError(res, 400, (e as Error).message, 'bad_request');
    }
    return;
  }

  sse(res);

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    for await (const delta of streamChat({ apiKey: KEY, model: MODEL, messages, signal: ac.signal })) {
      sseSend(res, { delta });
    }
    sseDone(res);
  } catch (e) {
    // If the client already disconnected, don't attempt to write to the
    // destroyed socket — it's pointless and would throw.
    if (ac.signal.aborted) return;
    const msg = (e as Error).message || 'upstream error';
    // Best-effort classification of upstream failures for the client.
    let kind: 'unauthorized' | 'rate_limit' | 'server' = 'server';
    if (/401|invalid[_ -]?api[_ -]?key|incorrect api key|unauthorized/i.test(msg)) {
      kind = 'unauthorized';
    } else if (/429|rate[_ -]?limit/i.test(msg)) {
      kind = 'rate_limit';
    }
    sseSend(res, { error: msg, kind });
    sseDone(res);
  }
});

server.listen(PORT, () => {
  console.log(`mascot proxy listening on http://localhost:${PORT}`);
  console.log(`  model:           ${MODEL}`);
  console.log(`  allowed origins: ${ALLOWED.join(', ') || '(none)'}`);
  console.log(`  rate limit:      ${RPM} req/min/ip`);
});
