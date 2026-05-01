import { describe, expect, it } from 'vitest';
import { askStreaming, MascotError } from '../src/chat-client.js';

const enc = new TextEncoder();

function makeStream(events: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

describe('chat-client error classification', () => {
  it('classifies HTTP 401 as unauthorized (not retryable)', async () => {
    const fetchImpl = (async () =>
      new Response('invalid api key', { status: 401 })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      try {
        await askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
        });
        expect.fail('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(MascotError);
        const err = e as MascotError;
        expect(err.kind).toBe('unauthorized');
        expect(err.retryable).toBe(false);
        expect(err.status).toBe(401);
      }
    });
  });

  it('classifies HTTP 429 as rate_limit and parses Retry-After (seconds)', async () => {
    const fetchImpl = (async () =>
      new Response('rate limit exceeded', {
        status: 429,
        headers: { 'retry-after': '7' },
      })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      try {
        await askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
        });
        expect.fail('expected throw');
      } catch (e) {
        const err = e as MascotError;
        expect(err.kind).toBe('rate_limit');
        expect(err.retryable).toBe(true);
        expect(err.retryAfterMs).toBe(7000);
      }
    });
  });

  it('classifies HTTP 503 with key wording as unauthorized', async () => {
    const fetchImpl = (async () =>
      new Response('server is missing OPENAI_API_KEY', { status: 503 })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      try {
        await askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
        });
        expect.fail('expected throw');
      } catch (e) {
        expect((e as MascotError).kind).toBe('unauthorized');
      }
    });
  });

  it('classifies fetch TypeError as network', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      try {
        await askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
        });
        expect.fail('expected throw');
      } catch (e) {
        expect((e as MascotError).kind).toBe('network');
        expect((e as MascotError).retryable).toBe(true);
      }
    });
  });

  it('classifies AbortError as aborted (not retryable)', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      try {
        await askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
        });
        expect.fail('expected throw');
      } catch (e) {
        expect((e as MascotError).kind).toBe('aborted');
        expect((e as MascotError).retryable).toBe(false);
      }
    });
  });

  it('honors structured SSE error events (kind from server)', async () => {
    const stream = makeStream([
      'data: {"error":"upstream rate","kind":"rate_limit"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      try {
        await askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
        });
        expect.fail('expected throw');
      } catch (e) {
        expect((e as MascotError).kind).toBe('rate_limit');
      }
    });
  });

  it('streams deltas and resolves with full text on [DONE]', async () => {
    const stream = makeStream([
      'data: {"delta":"He"}\n\n',
      'data: {"delta":"llo"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      const tokens: string[] = [];
      const full = await askStreaming({
        endpoint: '/x',
        messages: [{ role: 'user', content: 'hi' }],
        onToken: (d) => tokens.push(d),
      });
      expect(full).toBe('Hello');
      expect(tokens).toEqual(['He', 'llo']);
    });
  });
});
