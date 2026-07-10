import { describe, expect, it } from 'vitest';

import { isBatchTerminal, responseText } from './translate-batch';

describe('isBatchTerminal', () => {
  it('treats succeeded/failed/cancelled/expired as terminal', () => {
    for (const s of [
      'JOB_STATE_SUCCEEDED',
      'JOB_STATE_FAILED',
      'JOB_STATE_CANCELLED',
      'JOB_STATE_EXPIRED',
    ]) {
      expect(isBatchTerminal(s)).toBe(true);
    }
  });

  it('keeps polling for in-flight states', () => {
    for (const s of [
      'JOB_STATE_PENDING',
      'JOB_STATE_QUEUED',
      'JOB_STATE_RUNNING',
      'JOB_STATE_UNSPECIFIED',
    ]) {
      expect(isBatchTerminal(s)).toBe(false);
    }
  });
});

describe('responseText', () => {
  const withText = (...texts: string[]) => ({
    response: {
      candidates: [{ content: { parts: texts.map((text) => ({ text })) } }],
    },
  });

  it('joins the parts of the first candidate', () => {
    expect(responseText(withText('<title>Hi</title>', '<article>…'))).toBe(
      '<title>Hi</title><article>…',
    );
  });

  it('returns empty string when the response is missing or shapeless', () => {
    expect(responseText(undefined)).toBe('');
    expect(responseText({})).toBe('');
    expect(responseText({ response: {} })).toBe('');
    expect(responseText({ response: { candidates: [] } })).toBe('');
    expect(responseText({ response: { candidates: [{ content: {} }] } })).toBe(
      '',
    );
  });

  it('tolerates parts with a missing text field', () => {
    expect(
      responseText({
        response: { candidates: [{ content: { parts: [{}, { text: 'x' }] } }] },
      }),
    ).toBe('x');
  });
});
