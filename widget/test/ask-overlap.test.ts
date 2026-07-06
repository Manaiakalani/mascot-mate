// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { init } from '../src/index.js';

const enc = new TextEncoder();

function makeStream(events: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

function sseResponse(events: string[]): Response {
  return new Response(makeStream(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('MascotImpl.ask() overlap handling', () => {
  let container: HTMLDivElement;
  let origFetch: typeof fetch;
  let calls: { body: string }[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    origFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    document.body.removeChild(container);
    globalThis.fetch = origFetch;
  });

  it('cleans up the superseded request without corrupting the newer one\'s history', async () => {
    let call = 0;
    globalThis.fetch = (async (_url: string, opts: RequestInit) => {
      const idx = call++;
      calls.push({ body: opts.body as string });
      if (idx === 0) {
        // Question A: never settles on its own — only rejects when aborted,
        // simulating a slow in-flight request that a newer ask() supersedes.
        return new Promise<Response>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      // Question B and Question C both resolve normally and immediately.
      return sseResponse([`data: {"delta":"reply-${idx}"}\n\n`, 'data: [DONE]\n\n']);
    }) as unknown as typeof fetch;

    const instance = await init({ endpoint: '/x', mascot: 'clippy', parent: container });

    const askA = instance.ask('Question A');
    // Let ask("A") get far enough to push its history entry and start the
    // fetch before ask("B") supersedes it.
    await new Promise((r) => setTimeout(r, 0));
    const askB = instance.ask('Question B');

    await expect(askA).rejects.toThrow();
    await expect(askB).resolves.toBe('reply-1');

    // A third ask reveals exactly what's in history at this point, since
    // askStreaming() sends the full running history as the request body.
    await instance.ask('Question C');
    const lastBody = JSON.parse(calls[2]!.body) as { messages: { role: string; content: string }[] };
    const turns = lastBody.messages.map((m) => `${m.role}:${m.content}`);

    // Question A's turn must be gone (it was aborted/superseded), Question
    // B's turn + reply must be intact and in order, and nothing got dropped
    // or duplicated by the overlapping abort cleanup.
    expect(turns.slice(-3)).toEqual(['user:Question B', 'assistant:reply-1', 'user:Question C']);
    expect(turns.join(' | ')).not.toContain('Question A');

    instance.destroy();
  });
});
