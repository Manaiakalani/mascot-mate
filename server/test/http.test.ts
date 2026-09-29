import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyServer } from '../src/server.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function listen(env: Record<string, string | undefined>): Promise<{ server: Server; base: string }> {
  const server = createProxyServer(env);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function call(
  base: string,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: NodeJS.Dict<string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('proxy HTTP', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('returns 503 for a missing key without spending a rate-limit token', async () => {
    const { server, base } = await listen({ RATE_LIMIT_RPM: '1' });
    servers.push(server);
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const headers = { 'content-type': 'application/json' };
    const first = await call(base, 'POST', '/api/ask', body, headers);
    const second = await call(base, 'POST', '/api/ask', body, headers);
    expect(first.status).toBe(503);
    expect(JSON.parse(first.text)).toMatchObject({ kind: 'unauthorized' });
    expect(second.status).toBe(503);
  });

  it('rate-limits a bad ask token and allows the preflight header', async () => {
    const { server, base } = await listen({
      OPENAI_API_KEY: 'sk-test',
      ASK_TOKEN: 'secret',
      RATE_LIMIT_RPM: '1',
    });
    servers.push(server);
    const preflight = await call(base, 'OPTIONS', '/api/ask', undefined, { origin: 'https://example.test' });
    expect(preflight.status).toBe(204);
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('x-mascot-token');

    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const headers = { 'content-type': 'application/json', 'x-mascot-token': 'nope' };
    const denied = await call(base, 'POST', '/api/ask', body, headers);
    const limited = await call(base, 'POST', '/api/ask', body, headers);
    expect(denied.status).toBe(401);
    expect(JSON.parse(denied.text).error).toBe('missing or invalid token');
    expect(limited.status).toBe(429);
  });

  it('rejects an oversized body, bad JSON, and too many messages', async () => {
    const { server, base } = await listen({ OPENAI_API_KEY: 'sk-test', RATE_LIMIT_RPM: '30' });
    servers.push(server);
    const headers = { 'content-type': 'application/json' };
    const tooBig = await call(base, 'POST', '/api/ask', 'x'.repeat(32 * 1024 + 1), headers);
    expect(tooBig.status).toBe(413);

    const badJson = await call(base, 'POST', '/api/ask', '{', headers);
    expect(badJson.status).toBe(400);
    expect(JSON.parse(badJson.text).error).toBe('request body must be JSON');

    const messages = Array.from({ length: 41 }, () => ({ role: 'user', content: 'hi' }));
    const tooMany = await call(base, 'POST', '/api/ask', JSON.stringify({ messages }), headers);
    expect(tooMany.status).toBe(400);
    expect(JSON.parse(tooMany.text).error).toBe('too many messages');
  });

  it('streams a reply and hides the provider body on an upstream error', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    let mode: 'ok' | 'leak' = 'ok';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body ?? '') });
      if (mode === 'leak') {
        return new Response('secret-org sk-live-should-not-leak', { status: 401 });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const { server, base } = await listen({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'gpt-5',
      SYSTEM_PROMPT: 'pinned',
      OPENAI_MAX_TOKENS: '32',
      RATE_LIMIT_RPM: '20',
    });
    servers.push(server);
    const headers = { 'content-type': 'application/json' };
    const ok = await call(
      base,
      'POST',
      '/api/ask',
      JSON.stringify({
        messages: [
          { role: 'system', content: 'from the browser' },
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'smuggled' },
        ],
      }),
      headers,
    );
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('"delta":"Hi"');
    const posted = JSON.parse(seen[0]!.body) as { messages: { role: string; content: string }[]; max_completion_tokens?: number };
    expect(posted.messages).toEqual([
      { role: 'system', content: 'pinned' },
      { role: 'user', content: 'hi' },
    ]);
    expect(posted.max_completion_tokens).toBe(32);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');

    mode = 'leak';
    const failed = await call(
      base,
      'POST',
      '/api/ask',
      JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      headers,
    );
    expect(failed.status).toBe(200);
    expect(failed.text).toContain('"kind":"unauthorized"');
    expect(failed.text).toContain('upstream rejected the API key');
    expect(failed.text).not.toContain('secret-org');
  });
});
