import { test, expect } from 'bun:test';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { installSessionManager, ManagerSummaryTimer, MANAGER_REVIEW_MS } from '../src/extension/session-manager';
import { managerOperationSchema, type ManagerOperation, type ManagerResult } from '../src/shared/manager';

function fixture(options: { entries?: unknown[]; changes?: boolean; partial?: boolean; unknown?: boolean } = {}) {
  const managerId = crypto.randomUUID(), instanceId = crypto.randomUUID();
  const target = { pcId: 'owned', sessionId: 'worker', instanceId: crypto.randomUUID() };
  let now = MANAGER_REVIEW_MS * 2, busy = false, pending = false, current = true;
  const timers = new Map<number, () => void>(), sent: Array<{ message: { content: string; display: boolean }; options: { triggerTurn: boolean } }> = [], records: Array<{ phase: string }> = [], operations: ManagerOperation[] = [], contexts: unknown[][] = [];
  let next = 0, calls = 0, release: (() => void) | undefined;
  const pi = { appendEntry(_type: string, data: { phase: string }) { records.push(data); }, sendMessage(message: { content: string; display: boolean }, options: { triggerTurn: boolean }) { sent.push({ message, options }); if (options.triggerTurn) throw Error('unexpected_root_turn'); } } as unknown as ExtensionAPI;
  let wake: ManagerSummaryTimer;
  const ctx = { sessionManager: { getEntries: () => options.unknown ? [{ type: 'custom', customType: 'manager:summary-state', data: { managerId, id: 'unknown', at: now, from: now - MANAGER_REVIEW_MS, to: now, phase: 'intent' } }] : [], getSessionId: () => 'manager' },
    isIdle: () => !busy, hasPendingMessages: () => pending,
    setTimeout(fn: () => void) { const id = ++next; timers.set(id, fn); return id; }, clearTimer(id: number) { timers.delete(id); },
    async runEphemeralTurn(args: Parameters<NonNullable<ExtensionContext['runEphemeralTurn']>>[0]) {
      calls++;
      expect(args.tools).toBe(false); expect(args.maxTokens).toBe(600);
      const prompt = { role: 'user', content: [{ type: 'text', text: args.promptText }] };
      contexts.push(wake.filter([{ role: 'user', content: 'OLD_ROOT_MARKER' }, { customType: 'manager:update', content: 'OLD_WAKE' }, prompt]));
      if (release) { const gate = Promise.withResolvers<void>(); release = gate.resolve; await gate.promise; }
      return { replyText: 'Worker: changed a file. Coverage limited where indicated.' };
    },
  } as unknown as ExtensionContext;
  const request = async (operation: ManagerOperation): Promise<ManagerResult> => {
    operations.push(operation);
    if (operation.kind === 'status') return { ok: true, value: { kind: 'status', snapshot: { manager: { id: managerId, hostPcId: 'owned', lifecycle: 'online', binding: { managerId, hostPcId: 'owned', launchId: crypto.randomUUID(), sessionId: 'manager', instanceId, generation: 1 } }, observedAt: now } } };
    if (operation.kind === 'list') return { ok: true, value: { kind: 'list', page: { items: [{ target, name: 'Worker', managedAgent: undefined }], total: 1, nextCursor: null } } } as ManagerResult;
    if (operation.kind === 'changes') return { ok: true, value: { kind: 'changes', target, result: { kind: 'changes', sessionId: target.sessionId, from: operation.from, to: operation.to, entries: options.entries ?? (options.changes ? [{ at: operation.from, text: 'IN_WINDOW' }] : []), nextCursor: null, truncated: !!options.partial, coverage: { from: operation.from, to: operation.to, complete: !options.partial, gaps: options.partial ? ['Some entries omitted'] : [] } } } } as ManagerResult;
    throw Error('unexpected_operation');
  };
  wake = new ManagerSummaryTimer(pi, ctx, managerId, instanceId, () => current, request, () => now);
  return { wake, sent, records, operations, contexts, get calls() { return calls; }, get now() { return now; }, set busy(value: boolean) { busy = value; }, set pending(value: boolean) { pending = value; }, set current(value: boolean) { current = value; },
    hold() { release = () => {}; }, release() { release?.(); release = undefined; },
    async flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); },
    async tick() { now += MANAGER_REVIEW_MS; const [id, callback] = timers.entries().next().value!; timers.delete(id); callback(); for (let i = 0; i < 16; i++) await Promise.resolve(); },
    advance(ms: number) { now += ms; },
  };
}

test('normal workers cannot register Manager tools; removed coordination operations reject', () => {
  let count = 0;
  installSessionManager({ registerTool() { count++; } } as unknown as ExtensionAPI, () => false, async () => ({ ok: false, code: 'not_authorized' }));
  expect(count).toBe(0);
  for (const kind of ['action', 'events', 'events_ack', 'propose_assignment', 'task_update', 'questions']) expect(managerOperationSchema.safeParse({ kind }).success).toBe(false);
});

test('first tick only after full interval; no changes posts visible notice without model or trigger', async () => {
  const f = fixture();
  try { await f.wake.reconcile(); await f.wake.reconcile(); f.wake.idle(); await f.flush(); expect(f.sent).toEqual([]); expect(f.operations.map(o => o.kind)).toEqual(['status', 'status']); await f.tick(); expect(f.sent).toHaveLength(1); expect(f.calls).toBe(0); expect(f.sent[0]!.options.triggerTurn).toBe(false); expect(f.sent[0]!.message.display).toBe(true); expect(f.records.map(r => r.phase)).toEqual(['intent', 'settled']); } finally { f.wake.close(); }
});

test('summary sees only frozen in-window delta; historical root/wake excluded and partial coverage explicit', async () => {
  const f = fixture({ changes: true, partial: true });
  try { await f.wake.reconcile(); await f.tick(); expect(f.calls).toBe(1); expect(f.contexts[0]).toHaveLength(1); const text = JSON.stringify(f.contexts[0]); expect(text).toContain('IN_WINDOW'); expect(text).toContain('Some entries omitted'); expect(text).not.toContain('OLD_ROOT_MARKER'); expect(text).not.toContain('OLD_WAKE'); expect(f.sent).toHaveLength(1); expect(f.sent[0]!.options.triggerTurn).toBe(false); } finally { f.wake.close(); }
});

test('busy defers latest frozen tick only, never slides window to idle or queues backlog', async () => {
  const f = fixture({ changes: true });
  try { await f.wake.reconcile(); f.busy = true; await f.tick(); await f.tick(); const end = f.now; f.advance(5 * 60000); f.busy = false; f.wake.idle(); await f.flush(); const queries = f.operations.filter(o => o.kind === 'changes'); expect(queries).toHaveLength(1); expect(queries[0]).toMatchObject({ from: end - MANAGER_REVIEW_MS, to: end }); expect(JSON.stringify(f.contexts)).toContain('Older busy windows'); expect(f.calls).toBe(1); } finally { f.wake.close(); }
});

test('exclusive end boundary rejected and incomplete no-change coverage does not call provider', async () => {
  const f = fixture({ entries: [{ at: MANAGER_REVIEW_MS * 3, text: 'AFTER_TICK' }] });
  try { await f.wake.reconcile(); await f.tick(); expect(f.calls).toBe(0); expect(f.sent[0]!.message.content).toContain('invalid window'); } finally { f.wake.close(); }
});

test('unknown prior window is never replayed but later half-hour windows continue', async () => {
  const f = fixture({ unknown: true, changes: true });
  try {
    const oldEnd = f.now;
    await f.wake.reconcile(true); await f.flush();
    expect(f.calls).toBe(0); expect(f.sent).toEqual([]);
    await f.tick(); expect(f.calls).toBe(1);
    f.wake.disconnected(); await f.wake.reconcile(true); await f.flush();
    expect(f.calls).toBe(1);
    await f.tick(); expect(f.calls).toBe(2);
    expect(f.operations.filter(o => o.kind === 'changes').map(o => ({ from: o.from, to: o.to }))).toEqual([
      { from: oldEnd, to: oldEnd + MANAGER_REVIEW_MS },
      { from: oldEnd + MANAGER_REVIEW_MS, to: oldEnd + MANAGER_REVIEW_MS * 2 },
    ]);
  } finally { f.wake.close(); }
});

test('single active summary fences interrupted output without disabling later due windows', async () => {
  const f = fixture({ changes: true });
  try {
    f.hold(); await f.wake.reconcile(); await f.tick(); expect(f.calls).toBe(1);
    await f.tick(); expect(f.calls).toBe(1);
    await f.wake.reconcile(true); f.release(); await f.flush(); expect(f.sent).toEqual([]);
    f.wake.idle(); await f.flush(); expect(f.calls).toBe(2); expect(f.sent).toHaveLength(1);
    const windows = f.operations.filter(o => o.kind === 'changes').map(o => ({ from: o.from, to: o.to }));
    expect(windows).toEqual([
      { from: MANAGER_REVIEW_MS * 2, to: MANAGER_REVIEW_MS * 3 },
      { from: MANAGER_REVIEW_MS * 3, to: MANAGER_REVIEW_MS * 4 },
    ]);
  } finally { f.wake.close(); }
});

test('disconnect discards pending tick and new binding waits full interval; stale ownership emits nothing', async () => {
  const f = fixture();
  try { await f.wake.reconcile(); f.busy = true; await f.tick(); f.wake.disconnected(); f.busy = false; await f.wake.reconcile(); f.wake.idle(); await f.flush(); expect(f.sent).toEqual([]); f.current = false; await f.tick(); expect(f.sent).toEqual([]); } finally { f.wake.close(); }
});

test('empty partial window posts bounded unavailable notice without inference', async () => {
  const f = fixture({ partial: true });
  try { await f.wake.reconcile(); await f.tick(); expect(f.calls).toBe(0); expect(f.sent[0]!.message.content).toContain('no changes confirmed; coverage limited'); expect(f.sent[0]!.message.content.length).toBeLessThan(600); } finally { f.wake.close(); }
});
