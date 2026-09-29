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

/** Server rejects bodies above this. Stay under it on the client. */
export const MAX_CHAT_MESSAGES = 32;
export const MAX_MESSAGE_CHARS = 4000;
/** No bytes for this long means the upstream is hung. */
export const DEFAULT_STALL_MS = 45_000;

export interface AskOptions {
  endpoint: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Override the stall timeout. Tests use a few milliseconds. */
  stallMs?: number;
  /** Sent as `x-mascot-token` when the proxy requires `ASK_TOKEN`. */
  token?: string;
  onToken: (delta: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Keep the system prompt plus the newest turns. The proxy rejects a history
 * longer than its message cap, which used to fail every later question.
 */
export function trimChatHistory(messages: ChatMessage[], max = MAX_CHAT_MESSAGES): ChatMessage[] {
  if (messages.length <= max) return messages;
  const keepSystem = messages[0]?.role === 'system';
  const head = keepSystem ? [messages[0]!] : [];
  const tail = messages.slice(keepSystem ? 1 : 0).slice(-(max - head.length));
  return head.concat(tail);
}

/** Copy with each turn clipped to the proxy's per-message character cap. */
export function clampMessageChars(messages: ChatMessage[], maxChars = MAX_MESSAGE_CHARS): ChatMessage[] {
  return messages.map((message) =>
    message.content.length > maxChars ? { ...message, content: message.content.slice(0, maxChars) } : message,
  );
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

/**
 * The server always sends errors as `{ error, kind }` JSON (see
 * server.ts's sendJsonError), but callers here shouldn't crash or leak raw
 * JSON syntax into the UI for a non-JSON or malformed body — so this falls
 * back to the raw text whenever parsing doesn't yield a usable message.
 */
const KNOWN_KINDS = new Set<MascotErrorKind>([
  'rate_limit', 'unauthorized', 'network', 'timeout', 'aborted',
  'bad_request', 'server', 'unknown',
]);

function extractErrorInfo(body: string): { message: string; kind?: MascotErrorKind } {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; kind?: unknown };
      const message = typeof parsed.error === 'string' && parsed.error ? parsed.error : trimmed;
      const rawKind = typeof parsed.kind === 'string' ? parsed.kind : undefined;
      const kind = rawKind && KNOWN_KINDS.has(rawKind as MascotErrorKind)
        ? (rawKind as MascotErrorKind) : undefined;
      return { message, kind };
    } catch {
      // Not valid JSON — fall through to the raw text below.
    }
  }
  return { message: trimmed };
}

function classifyHttp(status: number, body: string): MascotError {
  const { message, kind: serverKind } = extractErrorInfo(body);
  const text = message || `HTTP ${status}`;
  // Prefer the server's own error kind when available; fall back to
  // status-code heuristics only when the server didn't classify.
  if (serverKind) {
    return new MascotError(serverKind, text, { status });
  }
  if (status === 401 || status === 403) {
    return new MascotError('unauthorized', text, { status });
  }
  if (status === 429) {
    return new MascotError('rate_limit', text, { status });
  }
  if (status === 400 || status === 413 || status === 422) {
    return new MascotError('bad_request', text, { status });
  }
  if (status === 503 && /key|api[_ -]key|missing|configur/i.test(message)) {
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

function splitSse(buf: string, flush: boolean): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buf;
  for (;;) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    events.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  // Streams often close on the last `data:` line without a blank terminator.
  if (flush && rest.trim()) {
    events.push(rest);
    rest = '';
  }
  return { events, rest };
}

function errorText(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'upstream error';
}

function applyEvent(event: string, opts: AskOptions, state: { full: string }): 'done' | 'continue' {
  const line = event.split('\n').find((l) => l.startsWith('data:'));
  if (!line) return 'continue';
  const payload = line.slice(5).trim();
  if (!payload) return 'continue';
  if (payload === '[DONE]') return 'done';
  let parsed: { delta?: string; error?: unknown; kind?: string };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch (e) {
    opts.onError?.(e as Error);
    return 'continue';
  }
  if (parsed.error) {
    const kind =
      parsed.kind && KNOWN_KINDS.has(parsed.kind as MascotErrorKind)
        ? (parsed.kind as MascotErrorKind)
        : 'server';
    throw new MascotError(kind, errorText(parsed.error));
  }
  if (parsed.delta) {
    state.full += parsed.delta;
    opts.onToken(parsed.delta);
  }
  return 'continue';
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stallMs: number,
  external?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (external?.aborted) return Promise.reject(new MascotError('aborted', 'request aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MascotError('timeout', 'response timed out'));
    }, stallMs);
    const onAbort = (): void => reject(new MascotError('aborted', 'request aborted'));
    external?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
        reject(classifyThrown(error));
      },
    );
  });
}

export async function askStreaming(opts: AskOptions): Promise<string> {
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const ac = new AbortController();
  const onExternal = (): void => ac.abort();
  opts.signal?.addEventListener('abort', onExternal);
  const fetchTimer = setTimeout(() => ac.abort(), stallMs);
  let res: Response;
  try {
    res = await fetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(opts.token ? { 'x-mascot-token': opts.token } : {}),
      },
      body: JSON.stringify({ messages: opts.messages }),
      signal: ac.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new MascotError('aborted', 'request aborted');
    if (ac.signal.aborted) throw new MascotError('timeout', 'response timed out');
    throw classifyThrown(e);
  } finally {
    clearTimeout(fetchTimer);
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
  const state = { full: '' };

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readChunk(reader, stallMs, opts.signal);
      } catch (e) {
        if (e instanceof MascotError) throw e;
        throw classifyThrown(e);
      }
      if (chunk.done) {
        buf += decoder.decode();
        const tail = splitSse(buf, true);
        for (const event of tail.events) {
          if (applyEvent(event, opts, state) === 'done') return state.full;
        }
        break;
      }
      buf += decoder.decode(chunk.value, { stream: true });
      const split = splitSse(buf, false);
      buf = split.rest;
      for (const event of split.events) {
        if (applyEvent(event, opts, state) === 'done') return state.full;
      }
    }
  } catch (e) {
    void reader.cancel().catch(() => {});
    throw e;
  } finally {
    opts.signal?.removeEventListener('abort', onExternal);
  }
  return state.full;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
