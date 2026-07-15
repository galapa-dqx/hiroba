import { describe, expect, it } from 'vitest';

import { joinEventType } from './api';

describe('joinEventType', () => {
  it('stays inside the engine charset for event types', () => {
    // The PRODUCTION engine rejects sendEvent/waitForEvent types outside this
    // pattern with workflow.invalid_event_type; miniflare does not validate,
    // so only this test stands between a charset regression and every
    // production join notification silently failing (as `flow:<runId>` did).
    const type = joinEventType('8297b53f-eab4-4559-8da3-56c6d66d2ba7');
    expect(type).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
    expect(type.length).toBeLessThanOrEqual(100);
  });
});
