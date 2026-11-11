import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { Model } from '@oh-my-pi/pi-ai';
import { resolveModelPolicy } from '@oh-my-pi/pi-catalog/compat/resolve';
import { SessionConsult } from '../src/extension/session-consult';

test('real public SDK consultation distinguishes loopback provider and native guard failures without main history', async () => {
  if (process.env.CONSULT_SDK_CHILD !== '1') {
    const root = await mkdtemp(join(tmpdir(), 'session-consult-sdk-'));
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
      env: { ...process.env, CONSULT_SDK_CHILD: '1', CONSULT_SDK_ROOT: root, HOME: root, USERPROFILE: root, PI_CONFIG_DIR: root, PI_CODING_AGENT_DIR: join(root, 'agent') }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain('CONSULT_SDK_PROOF=passed');
    } finally { if (child.exitCode === null) { child.kill(); await child.exited; } await rm(root, { recursive: true, force: true }); }
    return;
  }
  const root = process.env.CONSULT_SDK_ROOT!;
  for (const key of Object.keys(process.env)) if (/^(?:OMP_|PI_|ANTHROPIC|OPENAI|GOOGLE|GEMINI|AZURE|AWS|GITHUB_TOKEN|GH_TOKEN)/.test(key)) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  // Intentional test module-loading boundary: SDK must initialize after isolated HOME/config and credential removal.
  const sdk = await import('@oh-my-pi/pi-coding-agent');
  const { initializeExtensions } = await import('@oh-my-pi/pi-coding-agent/modes/runtime-init');
  let mode = 'long';
  const privatePayload = 'PRIVATE_SYNTHETIC_PROVIDER_PAYLOAD';
  const longAnswer = Array.from({ length: 128 }, (_, index) => createHash('sha256').update(`synthetic-line-${index}`).digest('hex')).join('\n');
  const payloads: { tools?: unknown[]; tool_choice?: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json() as never);
    if (mode === 'error') return Response.json({ error: { message: privatePayload, type: 'invalid_request_error' } }, { status: 400 });
    const chunk = (content: string, finish: string | null) => ({ id: 'owned-local', object: 'chat.completion.chunk', created: 1, model: 'owned', choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason: finish }] });
    const text = mode === 'long' ? longAnswer : mode === 'loop' ? 'Repeated structured line\n'.repeat(400).trim() : 'partial';
    return new Response(`data: ${JSON.stringify(chunk(text, null))}\n\ndata: ${JSON.stringify(chunk('', mode === 'length' ? 'length' : 'stop'))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const origin = `http://127.0.0.1:${server.port}`, originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw Error('external_network_forbidden');
    return originalFetch(input, init);
  }, { preconnect() {} });
  const manager = sdk.SessionManager.inMemory(root);
  manager.appendCustomMessageEntry('owned:seed', 'SYNTHETIC_HISTORY', true, undefined, 'user');
  const spec = { id: 'owned', name: 'Owned loopback fixture', provider: 'owned-local', api: 'openai-completions' as const, baseUrl: `${origin}/v1`, reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 16000 };
  const policy = resolveModelPolicy(spec);
  const model: Model<'openai-completions'> = { ...spec, identity: policy.identity, compat: policy.compat };
  let consult: SessionConsult | undefined;
  const diagnostics: Readonly<Record<string, string | number | boolean>>[] = [];
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, 'agent'), settings: sdk.Settings.isolated(), sessionManager: manager, model, getApiKey: async () => 'owned-no-secret', disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false, toolNames: [], extensions: [(pi: ExtensionAPI) => {
    pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'owned-no-secret', models: [{ id: model.id, name: model.name, api: model.api, reasoning: false, input: model.input, cost: model.cost, contextWindow: 32000, maxTokens: 16000 }] });
    pi.on('session_start', (_event, ctx: ExtensionContext) => { consult = new SessionConsult(ctx, () => true, fields => diagnostics.push(fields)); });
  }] });
  try {
    await initializeExtensions(session, { reportSendError() { throw Error('unexpected-send'); }, reportRuntimeError() { throw Error('unexpected-runtime'); } });
    const before = JSON.stringify(manager.getEntries());
    const signal = AbortSignal.timeout(30000);
    const longResult = await consult!.handle({ kind: 'question', question: 'Synthetic informational question' }, signal);
    expect(longResult.kind, JSON.stringify(diagnostics)).toBe('answer');
    expect(longResult).toMatchObject({ kind: 'answer', text: longAnswer });
    mode = 'loop';
    expect(await consult!.handle({ kind: 'question', question: '?' }, signal)).toEqual({ kind: 'error', code: 'question_failed' });
    expect(diagnostics.at(-1)).toMatchObject({ outcome: 'question_failed', reason: 'thinking-loop' });
    mode = 'error';
    expect(await consult!.handle({ kind: 'question', question: '?' }, signal)).toEqual({ kind: 'error', code: 'question_failed' });
    expect(diagnostics.at(-1)).toMatchObject({ outcome: 'question_failed', stage: 'native-call' });
    mode = 'length';
    await consult!.handle({ kind: 'question', question: '?' }, signal);
    expect(diagnostics.at(-1)).toMatchObject({ outcome: "answer", stopReason: "length", empty: false });
    expect(JSON.stringify(manager.getEntries())).toBe(before);
    expect(JSON.stringify(diagnostics)).not.toContain(privatePayload);
    for (const payload of payloads) expect(payload.tools ?? []).toHaveLength(0);
    expect(session.isStreaming).toBe(false);
    console.log('CONSULT_SDK_PROOF=passed');
  } finally { await session.dispose(); globalThis.fetch = originalFetch; await server.stop(true); }
}, 60000);
