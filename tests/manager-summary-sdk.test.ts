import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { Model } from '@oh-my-pi/pi-ai';
import { resolveModelPolicy } from '@oh-my-pi/pi-catalog/compat/resolve';
import { ManagerSummaryTimer, MANAGER_REVIEW_MS } from '../src/extension/session-manager';
import type { ManagerOperation, ManagerResult } from '../src/shared/manager';

test('actual SDK summary request excludes historical conversation and tools; display-only result reaches canonical journal', async () => {
  if (process.env.MANAGER_SUMMARY_SDK_CHILD !== '1') {
    const root = await mkdtemp(join(tmpdir(), 'manager-summary-sdk-'));
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], { env: { ...process.env, MANAGER_SUMMARY_SDK_CHILD: '1', MANAGER_SUMMARY_SDK_ROOT: root, HOME: root, USERPROFILE: root, PI_CONFIG_DIR: root, PI_CODING_AGENT_DIR: join(root, 'agent') }, stdout: 'pipe', stderr: 'pipe' });
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain('MANAGER_SUMMARY_SDK_PROOF=passed');
    } finally { if (child.exitCode === null) { child.kill(); await child.exited; } await rm(root, { recursive: true, force: true }); }
    return;
  }
  const root = process.env.MANAGER_SUMMARY_SDK_ROOT!;
  for (const key of Object.keys(process.env)) if (/^(?:OMP_|PI_|ANTHROPIC|OPENAI|GOOGLE|GEMINI|AZURE|AWS|GITHUB_TOKEN|GH_TOKEN)/.test(key)) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  // Load the SDK only after this owned child's private configuration boundary exists.
  const sdk = await import('@oh-my-pi/pi-coding-agent');
  const { initializeExtensions } = await import('@oh-my-pi/pi-coding-agent/modes/runtime-init');
  const originalFetch = globalThis.fetch;
  const payloads: unknown[] = [], hookPayloads: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json());
    const chunk = (content: string, finish: string | null) => ({ id: 'owned-local', object: 'chat.completion.chunk', created: 1, model: 'owned', choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason: finish }] });
    return new Response(`data: ${JSON.stringify(chunk('Worker: updated its file.', null))}\n\ndata: ${JSON.stringify(chunk('', 'stop'))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const localFetch: typeof fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) throw Error('external_network_forbidden');
    return originalFetch(input, init);
  }, { preconnect() {} });
  globalThis.fetch = localFetch;
  const manager = sdk.SessionManager.inMemory(root);
  manager.appendCustomMessageEntry('owned:old', 'OLD_ROOT_MARKER', true, undefined, 'user');
  manager.appendCustomMessageEntry('manager:update', 'OLD_LEDGER_MARKER', true, undefined, 'agent');
  manager.appendCustomMessageEntry('owned:worker-history', 'OUTSIDE_WINDOW_WORKER_MARKER', true, undefined, 'agent');
  const managerId = crypto.randomUUID(), instanceId = crypto.randomUUID(), target = { pcId: 'owned', sessionId: 'worker', instanceId: crypto.randomUUID() };
  const now = MANAGER_REVIEW_MS * 3;
  const request = async (operation: ManagerOperation): Promise<ManagerResult> => {
    if (operation.kind === 'status') return { ok: true, value: { kind: 'status', snapshot: { manager: { id: managerId, hostPcId: 'owned', lifecycle: 'online', binding: { managerId, hostPcId: 'owned', launchId: crypto.randomUUID(), sessionId: manager.getSessionId(), instanceId, generation: 1 } }, observedAt: now } } };
    if (operation.kind === 'list') return { ok: true, value: { kind: 'list', page: { items: [{ target, name: 'Worker' }], total: 1, nextCursor: null } } } as ManagerResult;
    if (operation.kind === 'changes') return { ok: true, value: { kind: 'changes', target, result: { kind: 'changes', sessionId: target.sessionId, from: operation.from, to: operation.to, entries: [{ at: now - 1, text: 'IN_WINDOW_WORKER_MARKER' }], nextCursor: null, truncated: false, coverage: { from: operation.from, to: operation.to, complete: true, gaps: [] } } } };
    throw Error('side_question_forbidden');
  };
  const spec = { id: 'owned', name: 'Owned local transport fixture', provider: 'owned-local', api: 'openai-completions' as const, baseUrl: `${origin}/v1`, reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
  const policy = resolveModelPolicy(spec);
  const model: Model<'openai-completions'> = { ...spec, identity: policy.identity, compat: policy.compat };
  let timer: ManagerSummaryTimer | undefined, callback: (() => void) | undefined;
  const ready = Promise.withResolvers<void>(), posted = Promise.withResolvers<void>();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, 'agent'), settings: sdk.Settings.isolated(), sessionManager: manager, model, getApiKey: async () => 'owned-local-no-secret', disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false, toolNames: [], extensions: [(pi: ExtensionAPI) => {
    pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'owned-local-no-secret', models: [{ id: model.id, name: model.name, api: model.api, reasoning: false, input: model.input, cost: model.cost, contextWindow: 32000, maxTokens: 1024 }] });
    pi.on('session_start', (_event, ctx) => {
      // Native handler contexts inherit the public session fields; spreading loses them.
      const clocked: ExtensionContext = Object.assign(Object.create(ctx), {
        setTimeout(fn: () => void) { callback = fn; return 1 as unknown as Timer; }, clearTimer() {},
        async runEphemeralTurn(options: Parameters<NonNullable<ExtensionContext['runEphemeralTurn']>>[0]) {
          try { return await ctx.runEphemeralTurn!(options); }
          catch (error) { posted.reject(error); throw error; }
        },
      });
      timer = new ManagerSummaryTimer(pi, clocked, managerId, instanceId, () => true, request, () => now);
      ready.resolve();
    });
    pi.on('context', event => ({ messages: timer?.filter(event.messages) ?? event.messages }));
    pi.on('before_provider_request', event => { hookPayloads.push(event.payload); });
  }] });
  // Observe the real public SDK dispatch promise; forward unchanged to its implementation.
  const nativeSend = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = async (message, options) => {
    try {
      const result = await nativeSend(message, options);
      if (typeof message !== 'string' && message.customType === 'manager:summary') { expect(options?.triggerTurn).toBe(false); expect(result).toBe(false); posted.resolve(); }
      return result;
    } catch (error) { posted.reject(error); throw error; }
  };
  try {
    await initializeExtensions(session, { reportSendError: error => posted.reject(error), reportRuntimeError: error => posted.reject(error) });
    await ready.promise;
    await timer!.reconcile();
    expect(callback).toBeDefined();
    expect(payloads).toHaveLength(0);
    callback!();
    await posted.promise;
    expect(payloads).toHaveLength(1); expect(hookPayloads).toHaveLength(1);
    const serialized = JSON.stringify(payloads[0]);
    expect(serialized).toContain('IN_WINDOW_WORKER_MARKER');
    expect(serialized).not.toContain('OLD_ROOT_MARKER'); expect(serialized).not.toContain('OLD_LEDGER_MARKER');
    expect(serialized).not.toContain('OUTSIDE_WINDOW_WORKER_MARKER');
    const payload = payloads[0] as { tools?: unknown[]; messages: unknown[] };
    expect(payload.tools ?? []).toHaveLength(0);
    expect(manager.getEntries().some(entry => entry.type === 'custom_message' && entry.customType === 'manager:summary' && entry.content === 'Worker: updated its file.' && entry.display)).toBe(true);
    expect(session.isStreaming).toBe(false);
    console.log('MANAGER_SUMMARY_SDK_PROOF=passed');
  } finally { timer?.close(); await session.dispose(); globalThis.fetch = originalFetch; await server.stop(true); }
}, 60000);
