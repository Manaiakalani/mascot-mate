import type { OpenAIMessage } from './openai.js';

/**
 * Which chat-completions endpoint the proxy calls.
 * OpenAI stays the default when `OPENAI_API_KEY` is set. `XAI_API_KEY` alone
 * (or an `OPENAI_BASE_URL` on api.x.ai) selects the xAI-compatible API.
 */

const XAI_BASE = 'https://api.x.ai/v1';
const OPENAI_BASE = 'https://api.openai.com/v1';

export interface UpstreamConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Omitted from the request when undefined. */
  maxTokens?: number;
  /** Stall timeout: abort if the upstream sends no bytes for this long. */
  timeoutMs: number;
}

export function resolveUpstream(env: Record<string, string | undefined>): UpstreamConfig {
  const openaiKey = env.OPENAI_API_KEY?.trim() ?? '';
  const xaiKey = env.XAI_API_KEY?.trim() ?? '';
  const requestedBase = env.OPENAI_BASE_URL?.trim().replace(/\/$/, '') ?? '';
  const pointsAtXai = requestedBase ? /\/\/api\.x\.ai(?:\/|$)/.test(requestedBase) : !openaiKey && xaiKey.length > 0;
  const baseUrl = requestedBase || (pointsAtXai ? XAI_BASE : OPENAI_BASE);
  const apiKey = pointsAtXai ? xaiKey || openaiKey : openaiKey || xaiKey;
  const model = env.OPENAI_MODEL?.trim() || (pointsAtXai ? 'grok-4.7' : 'gpt-4o-mini');
  return {
    apiKey,
    baseUrl,
    model,
    maxTokens: parseMaxTokens(env.OPENAI_MAX_TOKENS),
    timeoutMs: positiveInt(env.OPENAI_TIMEOUT_MS, 45_000),
  };
}

/**
 * The widget sends its own system turn. When `SYSTEM_PROMPT` is set, that
 * wins and any client system turns are dropped so a public proxy can't be
 * retargeted. Otherwise only the first system turn is kept.
 */
export function pinSystemPrompt(
  messages: OpenAIMessage[],
  systemPrompt: string | undefined,
): OpenAIMessage[] {
  const rest = messages.filter((message) => message.role !== 'system');
  if (systemPrompt && systemPrompt.trim()) {
    return [{ role: 'system', content: systemPrompt }, ...rest];
  }
  const first = messages.find((message) => message.role === 'system');
  return first ? [first, ...rest] : rest;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseMaxTokens(raw: string | undefined): number | undefined {
  if (raw === undefined) return 512;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '0') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 512;
}
