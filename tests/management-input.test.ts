import { expect, test } from 'bun:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { ManagementInput } from '../src/extension/management-input';
import { ManagerDelivery } from '../src/extension/manager-delivery';
import { SentinelCorrection } from '../src/extension/sentinel-correction';

const target = { pcId: 'owned', sessionId: 'worker', instanceId: crypto.randomUUID() };
const collab = (timestamp: number, content = 'Direct owner correction') => ({ role: 'custom', customType: 'collab-prompt', attribution: 'user', content, display: true, timestamp });
function instruction(revision: number) {
  const now = Date.now(), assignmentId = crypto.randomUUID();
  return { type: 'manager_action' as const, actor: 'manager' as const, expiresAt: now + 60000,
    assignment: { id: assignmentId, revision: 1, title: 'Owned task', goal: 'Synthetic', constraints: 'Read only', acceptance: [] as string[], targets: [target], status: 'active' as const, createdAt: now, updatedAt: now },
    action: { actionId: crypto.randomUUID(), assignmentId, assignmentRevision: 1, target, expectedInputRevision: revision, operation: { kind: 'instruction' as const, text: 'Owned instruction', delivery: 'followUp' as const } } };
}

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

test('visible owner input fences both pending peer effects before context admission without changing input text', () => {
  const sent: unknown[] = [], managerReceipts: Array<{state:string;code?:string}> = [], sentinelReceipts: string[] = [], published: number[] = [];
  const pi = { sendMessage(message: unknown) { sent.push(message); } } as unknown as ExtensionAPI;
  const correction = new SentinelCorrection(pi, () => true, target.sessionId, target.instanceId, (_id, status) => sentinelReceipts.push(status));
  const input = new ManagementInput(() => { published.push(input.revision); correction.cancelPending(); });
  input.reset([]);
  const delivery = new ManagerDelivery(pi, target, () => ({ valid: input.available, inputRevision: input.revision, allowSteer: true, pendingToolApproval: false }), (_id, state, code) => managerReceipts.push({state, ...(code ? {code} : {})}));
  try {
    const oldCorrection = { type: 'sentinel_correction_request' as const, requestId: crypto.randomUUID(), sessionId: target.sessionId, instanceId: target.instanceId, text: 'Already admitted historical correction', expiresAt: Date.now() + 60000 };
    correction.request(oldCorrection); const historicalCorrection = sent.at(-1)!;
    expect(correction.filter([historicalCorrection])).toEqual([historicalCorrection]);
    const pendingCorrection = { ...oldCorrection, requestId: crypto.randomUUID(), text: 'Pending correction' };
    correction.request(pendingCorrection); const pending = sent.at(-1)!;
    const stale = instruction(0); delivery.request(stale); const staleMessage = sent.at(-1)!;
    const owner = collab(5000), original = structuredClone(owner);
    // The public context prefilter sees the complete context before either peer
    // filter, even when the newly visible user input is last in the array.
    const context = [historicalCorrection, pending, staleMessage, owner];
    expect(input.observe(context)).toBe(true);
    const filtered = delivery.filter(correction.filter(context));
    expect(published).toEqual([1]); expect(input.revision).toBe(1);
    expect(managerReceipts).toEqual([{state:'rejected',code:'input_changed'}]);
    expect(sentinelReceipts).toEqual(['context_admitted','cancelled']);
    expect(filtered).toEqual([historicalCorrection,owner]); expect(owner).toEqual(original);
    expect(filtered.at(-1)).toBe(owner);
    const fresh = instruction(1); delivery.request(fresh); const freshMessage = sent.at(-1)!;
    expect(input.observe([owner,freshMessage])).toBe(false);
    expect(delivery.filter([owner,freshMessage])).toEqual(expect.arrayContaining([owner,freshMessage]));
    expect(managerReceipts.at(-1)).toEqual({state:'admitted'});
    expect(owner.attribution).toBe('user');
  } finally { delivery.close(); correction.close(); }
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
