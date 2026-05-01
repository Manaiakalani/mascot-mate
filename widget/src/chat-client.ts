/**
 * Streams chat completions from the proxy server using SSE (text/event-stream).
 * Each `data: { "delta": "..." }` line is forwarded to onToken. The server
 * sends `data: [DONE]` to terminate (OpenAI convention).
 *
 * Errors are surfaced as a `MascotError` with a stable `kind` so callers can
 * present user-friendly copy and decide whether to offer a retry.
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AskOptions {
  endpoint: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onToken: (delta: string) => void;
  onError?: (err: Error) => void;
}

export type MascotErrorKind =
  | 'rate_limit'
  | 'unauthorized'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'bad_request'
  | 'server'
  | 'unknown';

export class MascotError extends Error {
  readonly kind: MascotErrorKind;
  readonly retryAfterMs?: number;
  readonly status?: number;
  constructor(
    kind: MascotErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'MascotError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause) (this as { cause?: unknown }).cause = opts.cause;
  }
  /** True for error kinds that the caller can sensibly invite the user to retry. */
  get retryable(): boolean {
    return (
      this.kind === 'rate_limit' ||
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'server'
    );
  }
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
  // HTTP-date — best-effort.
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return undefined;
}

function classifyHttp(status: number, body: string): MascotError {
  const trimmed = body.trim();
  const text = trimmed || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new MascotError('unauthorized', text, { status });
  }
  if (status === 429) {
    return new MascotError('rate_limit', text, { status });
  }
  if (status === 400 || status === 413 || status === 422) {
    return new MascotError('bad_request', text, { status });
  }
  if (status === 503 && /key|api[_ -]key|missing|configur/i.test(trimmed)) {
    return new MascotError('unauthorized', text, { status });
  }
  if (status >= 500) {
    return new MascotError('server', text, { status });
  }
  return new MascotError('unknown', text, { status });
}

function classifyThrown(e: unknown): MascotError {
  if (e instanceof MascotError) return e;
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new MascotError('aborted', 'request aborted');
  }
  if (e instanceof TypeError) {
    // fetch() raises TypeError for network failure, DNS, CORS, offline.
    return new MascotError('network', 'network unreachable', { cause: e });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new MascotError('unknown', msg, { cause: e });
}

export async function askStreaming(opts: AskOptions): Promise<string> {
  let res: Response;
  try {
    res = await fetch(opts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ messages: opts.messages }),
      signal: opts.signal,
    });
  } catch (e) {
    throw classifyThrown(e);
  }
  if (!res.ok || !res.body) {
    const text = await safeText(res);
    const err = classifyHttp(res.status, text);
    if (err.kind === 'rate_limit') {
      const ra = parseRetryAfter(res.headers.get('retry-after'));
      if (ra !== undefined) {
        throw new MascotError('rate_limit', err.message, {
          status: err.status,
          retryAfterMs: ra,
        });
      }
    }
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw classifyThrown(e);
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = event.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      let parsed: { delta?: string; error?: string; kind?: MascotErrorKind };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch (e) {
        opts.onError?.(e as Error);
        continue;
      }
      if (parsed.error) {
        throw new MascotError(parsed.kind ?? 'server', parsed.error);
      }
      if (parsed.delta) {
        full += parsed.delta;
        opts.onToken(parsed.delta);
      }
    }
  }
  return full;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
