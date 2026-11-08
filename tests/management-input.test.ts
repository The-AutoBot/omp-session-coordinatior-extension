import { expect, test } from 'bun:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { ManagementInput } from '../src/extension/management-input';
import { SentinelCorrection } from '../src/extension/sentinel-correction';

const target = { pcId: 'owned', sessionId: 'worker', instanceId: crypto.randomUUID() };
const collab = (timestamp: number, content = 'Direct owner correction') => ({ role: 'custom', customType: 'collab-prompt', attribution: 'user', content, display: true, timestamp });

test('live and canonical collab identities share one revision counter without replaying baseline history', () => {
  const published: number[] = [];
  const input = new ManagementInput(() => published.push(input.revision));
  const historical = collab(1000);
  input.reset([{ ...historical, role: undefined, type: 'custom_message', timestamp: new Date(1000).toISOString() }]);
  expect(input.observe([historical])).toBe(false); expect(input.revision).toBe(0);
  for (const customType of ['manager:instruction', 'sentinel:correction', 'manager:update']) {
    expect(input.observe([{ ...collab(2000), customType, attribution: 'agent' }])).toBe(false);
  }
  input.advance(); expect(input.revision).toBe(1);
  const fresh = collab(3000);
  expect(input.observe([fresh])).toBe(true); expect(published).toEqual([1, 2]);
  expect(input.observe([structuredClone(fresh)])).toBe(false); expect(input.revision).toBe(2);
  input.reset([fresh]); expect(input.revision).toBe(0);
  expect(input.observe([structuredClone(fresh)])).toBe(false);
  expect(input.observe([collab(4000)])).toBe(true); expect(input.revision).toBe(1);
});

test('visible owner input fences pending Sentinel effects before context admission without changing input text', () => {
  const sent: unknown[] = [], sentinelReceipts: string[] = [], published: number[] = [];
  const pi = { sendMessage(message: unknown) { sent.push(message); } } as unknown as ExtensionAPI;
  const correction = new SentinelCorrection(pi, () => true, target.sessionId, target.instanceId, (_id, status) => sentinelReceipts.push(status));
  const input = new ManagementInput(() => { published.push(input.revision); correction.cancelPending(); });
  input.reset([]);
  try {
    const oldCorrection = { type: 'sentinel_correction_request' as const, requestId: crypto.randomUUID(), sessionId: target.sessionId, instanceId: target.instanceId, text: 'Already admitted historical correction', expiresAt: Date.now() + 60000 };
    correction.request(oldCorrection); const historicalCorrection = sent.at(-1)!;
    expect(correction.filter([historicalCorrection])).toEqual([historicalCorrection]);
    const pendingCorrection = { ...oldCorrection, requestId: crypto.randomUUID(), text: 'Pending correction' };
    correction.request(pendingCorrection); const pending = sent.at(-1)!;
    const owner = collab(5000), original = structuredClone(owner);
    // The public context prefilter sees the complete context before either peer
    // filter, even when the newly visible user input is last in the array.
    const context = [historicalCorrection, pending, owner];
    expect(input.observe(context)).toBe(true);
    const filtered = correction.filter(context);
    expect(published).toEqual([1]); expect(input.revision).toBe(1);
    expect(sentinelReceipts).toEqual(['context_admitted','cancelled']);
    expect(filtered).toEqual([historicalCorrection,owner]); expect(owner).toEqual(original);
    expect(filtered.at(-1)).toBe(owner);
    expect(owner.attribution).toBe('user');
  } finally { correction.close(); }
});

test('bounded identity capacity refuses new automation rather than forgetting old input identities', () => {
  const input = new ManagementInput(() => {});
  input.reset(Array.from({length:4096}, (_,i) => collab(i)));
  expect(input.available).toBe(true);
  expect(input.observe([collab(5000)])).toBe(true);
  expect(input.available).toBe(false); expect(input.revision).toBe(1);
  expect(input.observe([collab(0)])).toBe(false);
  input.reset([]); expect(input.available).toBe(true); expect(input.revision).toBe(0);
});
