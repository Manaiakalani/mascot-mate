import { afterEach, describe, expect, it } from 'vitest';
import { streamChat, UpstreamError } from '../src/openai.js';

const enc = new TextEncoder();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let full = '';
  for await (const delta of gen) full += delta;
  return full;
}

describe('streamChat', () => {
  it('posts to the configured base URL with max_tokens', async () => {
    let url = '';
    let body = '';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      body = String(init?.body ?? '');
      return sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    }) as typeof fetch;

    const full = await collect(
      streamChat({
        apiKey: 'k',
        model: 'grok-4.7',
        baseUrl: 'https://api.x.ai/v1/',
        maxTokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(full).toBe('ok');
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(JSON.parse(body)).toMatchObject({ model: 'grok-4.7', max_tokens: 128, stream: true });
  });

  it('sends max_completion_tokens when asked', async () => {
    let body = '';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    }) as typeof fetch;
    await collect(
      streamChat({
        apiKey: 'k',
        model: 'gpt-5',
        maxTokens: 64,
        maxTokenField: 'max_completion_tokens',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const posted = JSON.parse(body) as { max_tokens?: number; max_completion_tokens?: number };
    expect(posted.max_completion_tokens).toBe(64);
    expect(posted.max_tokens).toBeUndefined();
  });

  it('yields a trailing data line that has no blank terminator', async () => {
    globalThis.fetch = (async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}]}\n',
      ])) as typeof fetch;
    const full = await collect(
      streamChat({ apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(full).toBe('Hi!');
  });

  it('throws a typed error that does not include the provider body', async () => {
    globalThis.fetch = (async () =>
      new Response('secret-org sk-live-should-not-leak', { status: 401, statusText: 'Unauthorized' })) as typeof fetch;
    const gen = streamChat({ apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    await expect(gen.next()).rejects.toMatchObject({ name: 'UpstreamError', kind: 'unauthorized', status: 401 });
    try {
      await gen.next();
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as Error).message).not.toContain('secret-org');
    }
  });
});
