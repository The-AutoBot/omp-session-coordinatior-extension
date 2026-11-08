import { test, expect, vi } from 'bun:test';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { installSessionManager, ManagerWake } from '../src/extension/session-manager';
import { managerOperationSchema, managerResultSchema } from '../src/shared/manager';
import type { ManagerOperation, ManagerResult } from '../src/shared/manager';
import { SessionBusClient } from '../src/extension/session-bus-client';
test('ordinary workers cannot register manager tool', () => {
  let count = 0;
  installSessionManager({ registerTool() { count++; } } as unknown as ExtensionAPI, () => false, async () => ({ ok: false, code: 'not_authorized' }));
  expect(count).toBe(0);
});
test('strict tools reject authority fields and forged approval', () => {
  expect(managerOperationSchema.safeParse({ kind: 'activate', assignmentId: crypto.randomUUID() }).success).toBe(false);
  expect(managerOperationSchema.safeParse({ kind: 'status', ownerKey: 'private' }).success).toBe(false);
  expect(managerResultSchema.safeParse({ ok: true, value: { kind: 'events_ack', throughSequence: 0, nonce: 'private' } }).success).toBe(false);
});
test('unknown journal wake intent suppresses reconnect reinjection', async () => {
  const managerId = crypto.randomUUID(), instanceId = crypto.randomUUID(), batchId = crypto.randomUUID();
  let sends = 0, writes = 0;
  const pi = { sendMessage() { sends++; }, appendEntry() { writes++; } } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getEntries: () => [{ type: 'custom', customType: 'manager:event-state', data: { phase: 'intent', managerId, instanceId, batchId, throughSequence: 4 } }], getSessionId: () => 'manager' }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const wake = new ManagerWake(pi, ctx, managerId, instanceId, () => true, async () => ({ ok: false, code: 'manager_unavailable' }));
  try {
    await wake.reconcile(); wake.changed(9); wake.idle();
    expect(sends).toBe(0); expect(writes).toBe(0);
    expect(wake.filter([{ customType: 'manager:update', content: 'copied', details: { phase: 'intent', managerId, instanceId, batchId, throughSequence: 4 } }])).toEqual([]);
  } finally { wake.close(); }
});
test('wake ACK follows exact context admission, never enqueue return', async () => {
  vi.useFakeTimers();
  const managerId = crypto.randomUUID(), instanceId = crypto.randomUUID();
  const messages: unknown[] = [], records: unknown[] = [], requests: string[] = [];
  const pi = { sendMessage(message: unknown) { messages.push(message); }, appendEntry(_type: string, value: unknown) { records.push(value); } } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getEntries: () => [], getSessionId: () => 'manager' }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const empty = { items: [], total: 0, nextCursor: null };
  const wake = new ManagerWake(pi, ctx, managerId, instanceId, () => true, async operation => {
    requests.push(operation.kind);
    if (operation.kind === 'events_ack') return { ok: true, value: { kind: 'events_ack', throughSequence: operation.throughSequence } };
    return { ok: true, value: { kind: 'status', snapshot: { manager: { id: managerId, hostPcId: 'owned', lifecycle: 'online', automation: 'running',
      binding: { managerId, hostPcId: 'owned', launchId: crypto.randomUUID(), sessionId: 'manager', instanceId, generation: 1 } },
      assignments: empty, sessions: empty, questions: empty, actions: empty, events: [], nextCursor: 5, reset: false, observedAt: Date.now() } } };
  });
  try {
    await wake.reconcile(); wake.changed(5); wake.changed(5);
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(messages).toHaveLength(1); expect(records).toHaveLength(1);
    expect(requests).not.toContain('events_ack');
    expect(wake.filter([{ ...messages[0] as object, content: 'tampered' }])).toEqual([]);
    expect(requests).not.toContain('events_ack');
    expect(wake.filter(messages)).toHaveLength(1);
    expect(records).toHaveLength(2); expect(requests.filter(k => k === 'events_ack')).toHaveLength(1);
    wake.filter(messages); wake.changed(5); wake.idle();
    expect(requests.filter(k => k === 'events_ack')).toHaveLength(1);
    expect(messages).toHaveLength(1);
  } finally { wake.close(); vi.useRealTimers(); }
});
test('pending question reconstruction does not block an independent ledger wake', async () => {
  vi.useFakeTimers();
  const managerId = crypto.randomUUID(), instanceId = crypto.randomUUID();
  const messages: unknown[] = [], acks: number[] = [];
  const pi = { sendMessage(message: unknown) { messages.push(message); }, appendEntry() {} } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getEntries: () => [], getSessionId: () => 'manager' }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const empty = { items: [], total: 0, nextCursor: null };
  const wake = new ManagerWake(pi, ctx, managerId, instanceId, () => true, async operation => {
    if (operation.kind === 'events_ack') { acks.push(operation.throughSequence); return { ok: true, value: { kind: 'events_ack', throughSequence: operation.throughSequence } }; }
    if (operation.kind !== 'status' || operation.page === undefined || operation.page === 'questions') return { ok: false, code: 'runtime_unavailable' };
    return { ok: true, value: { kind: 'status', snapshot: {
      manager: { id: managerId, hostPcId: 'owned', lifecycle: 'online', automation: 'running',
        binding: { managerId, hostPcId: 'owned', launchId: crypto.randomUUID(), sessionId: 'manager', instanceId, generation: 1 } },
      assignments: empty, sessions: empty, questions: empty, actions: empty, events: [], nextCursor: 9, reset: false, observedAt: Date.now(),
    } } };
  });
  try {
    await wake.reconcile();
    vi.advanceTimersByTime(2000); await Promise.resolve();
    expect(messages).toHaveLength(1);
    expect(acks).toEqual([]);
    expect(wake.filter(messages)).toHaveLength(1);
    expect(acks).toEqual([9]);
    wake.changed(9); wake.idle(); vi.advanceTimersByTime(2000); await Promise.resolve();
    expect(messages).toHaveLength(1);
  } finally { wake.close(); vi.useRealTimers(); }
});
test('real socket correlates strict manager results and exact connection proof', async () => {
  const connectionId = crypto.randomUUID(), sessionId = 'manager', instanceId = crypto.randomUUID();
  const { promise: registered, resolve: onRegistered } = Promise.withResolvers<void>();
  const { promise: proof, resolve: onProof } = Promise.withResolvers<void>();
  const managerRequests: string[] = [];
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response('Not found', { status: 404 }); },
    websocket: { message(ws, raw) {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'register') ws.send(JSON.stringify({ type: 'registered', sessionId, coordinator: false, managementConnectionId: connectionId }));
      if (frame.type === 'manager_bind_proof') { expect(frame.connectionId).toBe(connectionId); onProof(); }
      if (frame.type === 'manager_request') {
        managerRequests.push(frame.operation.kind);
        const result = frame.operation.kind === 'events_ack'
          ? { ok: true, value: { kind: 'events_ack', throughSequence: frame.operation.throughSequence } }
          : { ok: false, code: 'invalid_request' };
        ws.send(JSON.stringify({ type: 'manager_result', requestId: frame.requestId, result }));
      }
    } },
  });
  const timers = new Set<Timer>();
  const client = new SessionBusClient({
    url: `ws://127.0.0.1:${server.port}`, machineKey: 'owned-manager-test-key-0123456789',
    session: { pcId: 'owned', sessionId, instanceId, name: 'Manager', cwd: '/owned', role: 'participant', idle: true },
    allowSteer: false, interactiveRoot: true, onInboundMessage() {},
    timers: { setTimeout(fn, ms) { const t = setTimeout(fn, ms); timers.add(t); return t; }, clearTimer(t) { clearTimeout(t); timers.delete(t); } },
    onStatusChange(status) { if (status.state === 'registered') onRegistered(); },
  });
  try {
    client.start(); await registered;
    const p = { type: 'manager_bind_proof' as const, challengeId: crypto.randomUUID(), connectionId, nonce: 'b'.repeat(64) };
    expect(client.managerProof({ ...p, connectionId: crypto.randomUUID() })).toBe(false);
    expect(client.managerProof(p)).toBe(true); await proof;
    expect(await client.managerRequest({ kind: 'events_ack', throughSequence: 6 })).toEqual({ ok: true, value: { kind: 'events_ack', throughSequence: 6 } });
    const oversized: ManagerOperation = { kind: 'propose_assignment', title: 'Bounded', goal: '界'.repeat(8000), constraints: '\u0000'.repeat(8000),
      acceptance: Array.from({ length: 32 }, () => '界'.repeat(1000)),
      targets: Array.from({ length: 512 }, () => ({ pcId: 'a'.repeat(63), sessionId: '界'.repeat(200), instanceId })) };
    expect(Buffer.byteLength(JSON.stringify({ type: 'manager_request', requestId: crypto.randomUUID(), operation: oversized }), 'utf8')).toBeGreaterThan(512 * 1024);
    expect(await client.managerRequest(oversized)).toEqual({ ok: false, code: 'invalid_request' });
    expect(managerRequests).toEqual(['events_ack']);
  } finally { client.shutdown(); for (const timer of timers) clearTimeout(timer); await server.stop(true); }
});
test('human reconciliation and recovered reconciled records never manufacture admission ACKs', async () => {
  vi.useFakeTimers();
  const managerId = crypto.randomUUID(), instanceId = crypto.randomUUID(), batchId = crypto.randomUUID();
  const records: unknown[] = [{ phase: 'intent', managerId, instanceId, batchId, throughSequence: 4 }];
  const acks: number[] = [];
  let sends = 0;
  const empty = { items: [], total: 0, nextCursor: null };
  const request = async (operation: ManagerOperation): Promise<ManagerResult> => {
    if (operation.kind === 'events_ack') {
      acks.push(operation.throughSequence);
      return { ok: true, value: { kind: 'events_ack', throughSequence: operation.throughSequence } };
    }
    return { ok: true, value: { kind: 'status', snapshot: {
      manager: { id: managerId, hostPcId: 'owned', lifecycle: 'online', automation: 'running',
        binding: { managerId, hostPcId: 'owned', launchId: crypto.randomUUID(), sessionId: 'manager', instanceId, generation: 1 } },
      assignments: empty, sessions: empty, questions: empty, actions: empty, events: [], nextCursor: 8, reset: false, observedAt: Date.now(),
    } } };
  };
  const pi = { sendMessage() { sends++; }, appendEntry(_type: string, value: unknown) { records.push(value); } } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getEntries: () => records.map(data => ({ type: 'custom', customType: 'manager:event-state', data })), getSessionId: () => 'manager' },
    isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  let wake = new ManagerWake(pi, ctx, managerId, instanceId, () => true, request);
  try {
    await wake.reconcile(true);
    await wake.reconcile();
    expect(records.at(-1)).toMatchObject({ phase: 'reconciled', throughSequence: 8 });
    expect(acks).toEqual([]);
    wake.close();
    wake = new ManagerWake(pi, ctx, managerId, instanceId, () => true, request);
    await wake.reconcile(); wake.changed(8); wake.idle();
    vi.advanceTimersByTime(2000); await Promise.resolve();
    expect(sends).toBe(0); expect(acks).toEqual([]);
  } finally { wake.close(); vi.useRealTimers(); }
});
