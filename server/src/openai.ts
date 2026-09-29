/**
 * Streams a chat completion from the OpenAI API and yields incremental
 * content deltas. The generator finishes when the upstream sends [DONE].
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class UpstreamError extends Error {
  readonly kind: 'unauthorized' | 'rate_limit' | 'server';
  readonly status: number;
  constructor(status: number, kind: 'unauthorized' | 'rate_limit' | 'server') {
    super(`upstream ${status}`);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = status;
  }
}

function classifyStatus(status: number): 'unauthorized' | 'rate_limit' | 'server' {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limit';
  return 'server';
}

export async function* streamChat(opts: {
  apiKey: string;
  model: string;
  messages: OpenAIMessage[];
  signal?: AbortSignal;
  baseUrl?: string;
  maxTokens?: number;
}): AsyncGenerator<string, void, void> {
  const base = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  };
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    // Log the provider body server-side. Callers must not forward it.
    console.error(`upstream ${res.status}: ${text.slice(0, 500) || res.statusText}`);
    throw new UpstreamError(res.status, classifyStatus(res.status));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const consume = function* (event: string): Generator<string, boolean> {
    const line = event.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    try {
      const obj = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
        error?: { message?: string } | string;
      };
      if (obj.error) {
        const detail = typeof obj.error === 'string' ? obj.error : obj.error.message;
        console.error(`upstream stream error: ${detail ?? 'unknown'}`);
        throw new UpstreamError(502, 'server');
      }
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      // ignore malformed chunks
    }
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buf += decoder.decode();
      if (buf.trim()) {
        const finished = yield* consume(buf);
        if (finished) return;
      }
      return;
    }
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const finished = yield* consume(event);
      if (finished) return;
    }
  }
}
