import { describe, expect, it } from 'vitest';
import { maxTokenFieldFor, pinSystemPrompt, resolveUpstream } from '../src/upstream.js';

describe('resolveUpstream', () => {
  it('defaults to OpenAI when an OpenAI key is set', () => {
    const upstream = resolveUpstream({ OPENAI_API_KEY: 'sk-test' });
    expect(upstream.apiKey).toBe('sk-test');
    expect(upstream.baseUrl).toBe('https://api.openai.com/v1');
    expect(upstream.model).toBe('gpt-4o-mini');
    expect(upstream.maxTokens).toBe(512);
  });

  it('uses xAI when only XAI_API_KEY is set', () => {
    const upstream = resolveUpstream({ XAI_API_KEY: 'xai-test' });
    expect(upstream.apiKey).toBe('xai-test');
    expect(upstream.baseUrl).toBe('https://api.x.ai/v1');
    expect(upstream.model).toBe('grok-4.7');
  });

  it('prefers the xAI key when the base URL is api.x.ai', () => {
    const upstream = resolveUpstream({
      OPENAI_API_KEY: 'sk-test',
      XAI_API_KEY: 'xai-test',
      OPENAI_BASE_URL: 'https://api.x.ai/v1/',
    });
    expect(upstream.apiKey).toBe('xai-test');
    expect(upstream.baseUrl).toBe('https://api.x.ai/v1');
  });

  it('omits max_tokens when OPENAI_MAX_TOKENS is 0', () => {
    expect(resolveUpstream({ OPENAI_API_KEY: 'sk', OPENAI_MAX_TOKENS: '0' }).maxTokens).toBeUndefined();
  });

  it('uses max_completion_tokens for o-series and gpt-5, and max_tokens otherwise', () => {
    expect(maxTokenFieldFor('gpt-4o-mini', 'https://api.openai.com/v1')).toBe('max_tokens');
    expect(maxTokenFieldFor('gpt-5', 'https://api.openai.com/v1')).toBe('max_completion_tokens');
    expect(maxTokenFieldFor('o3-mini', 'https://api.openai.com/v1')).toBe('max_completion_tokens');
    expect(maxTokenFieldFor('gpt-5', 'https://api.x.ai/v1')).toBe('max_tokens');
    expect(maxTokenFieldFor('gpt-4o-mini', 'https://api.openai.com/v1', 'max_completion_tokens')).toBe(
      'max_completion_tokens',
    );
    expect(resolveUpstream({ OPENAI_API_KEY: 'sk', OPENAI_MODEL: 'gpt-5' }).maxTokenField).toBe(
      'max_completion_tokens',
    );
  });
});

describe('pinSystemPrompt', () => {
  it('replaces every client system turn when a server prompt is set', () => {
    const messages = pinSystemPrompt(
      [
        { role: 'system', content: 'from the browser' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'smuggled' },
      ],
      'pinned',
    );
    expect(messages).toEqual([
      { role: 'system', content: 'pinned' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('keeps only the first client system turn otherwise', () => {
    const messages = pinSystemPrompt(
      [
        { role: 'system', content: 'first' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'second' },
      ],
      undefined,
    );
    expect(messages).toEqual([
      { role: 'system', content: 'first' },
      { role: 'user', content: 'hi' },
    ]);
  });
});
