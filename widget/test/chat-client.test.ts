import { describe, expect, it } from 'vitest';
import { askStreaming, clampMessageChars, MascotError, trimChatHistory } from '../src/chat-client.js';

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

  it('extracts the friendly message from a JSON error body instead of leaking raw JSON', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'messages[0].content invalid', kind: 'bad_request' }), {
        status: 400,
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
        expect(err.kind).toBe('bad_request');
        expect(err.message).toBe('messages[0].content invalid');
        expect(err.message).not.toContain('{');
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

  it('flushes a final SSE event that has no trailing blank line', async () => {
    const stream = makeStream(['data: {"delta":"Hi"}\n\n', 'data: {"delta":"!"}\n']);
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      const full = await askStreaming({
        endpoint: '/x',
        messages: [{ role: 'user', content: 'hi' }],
        onToken: () => {},
      });
      expect(full).toBe('Hi!');
    });
  });

  it('rejects with timeout when the body stalls', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"delta":"Hi"}\n\n'));
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      await expect(
        askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
          stallMs: 40,
        }),
      ).rejects.toMatchObject({ kind: 'timeout' });
    });
  });

  it('rejects with timeout when the request never returns headers', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    await withFetch(fetchImpl, async () => {
      await expect(
        askStreaming({
          endpoint: '/x',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
          stallMs: 40,
        }),
      ).rejects.toMatchObject({ kind: 'timeout' });
    });
  });
});

describe('chat history shaping', () => {
  it('keeps the system turn and the newest messages', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `u${i}` })),
    ];
    const trimmed = trimChatHistory(messages, 4);
    expect(trimmed.map((m) => m.content)).toEqual(['sys', 'u7', 'u8', 'u9']);
  });

  it('clips overlong turns without mutating the original', () => {
    const original = [{ role: 'user' as const, content: 'abcdef' }];
    const clamped = clampMessageChars(original, 3);
    expect(clamped[0]?.content).toBe('abc');
    expect(original[0]?.content).toBe('abcdef');
  });
});
