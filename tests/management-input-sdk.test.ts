import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { Model } from '@oh-my-pi/pi-ai';
import { ManagementInput } from '../src/extension/management-input';
import { SentinelCorrection } from '../src/extension/sentinel-correction';

test('real SDK collab prompts fence pending Sentinel context without input events', async () => {
  if (process.env.MANAGEMENT_INPUT_SDK_CHILD !== '1') {
    const root = await mkdtemp(join(tmpdir(), 'management-input-sdk-'));
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', fileURLToPath(import.meta.url)], {
      env: { ...process.env, MANAGEMENT_INPUT_SDK_CHILD: '1', MANAGEMENT_INPUT_SDK_ROOT: root, HOME: root, USERPROFILE: root, PI_CONFIG_DIR: root, PI_CODING_AGENT_DIR: join(root, 'agent') }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const diagnostics = stdout.split(/\r?\n/).filter(line => /^MANAGEMENT_INPUT_SDK_(?:STAGE=[a-z_]+|FAILURE=[a-z_]+:(?:Error|TypeError|AssertionError))$/.test(line)).join('\n');
      expect(stdout.split(/\r?\n/), diagnostics).toContain('MANAGEMENT_INPUT_SDK_PROOF=passed');
      expect(code).toBe(0);
    } finally { if (child.exitCode === null) { child.kill(); await child.exited; } await rm(root, { recursive: true, force: true }); }
    return;
  }
  const root = process.env.MANAGEMENT_INPUT_SDK_ROOT!;
  for (const key of Object.keys(process.env)) if (/^(?:OMP_|PI_|ANTHROPIC|OPENAI|GOOGLE|GEMINI|AZURE|AWS|GITHUB_TOKEN|GH_TOKEN)/.test(key)) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  // SDK imports occur only after the owned child environment/network fence is installed.
  let stage = 'sdk_import';
  process.on('uncaughtException', error => {
    const name = error instanceof Error && ['Error', 'TypeError', 'AssertionError'].includes(error.name) ? error.name : 'Error';
    console.log(`MANAGEMENT_INPUT_SDK_FAILURE=${stage}:${name}`);
    process.exitCode = 1;
  });
  const forbidden = () => { throw Error('provider_or_network_forbidden'); };
  globalThis.fetch = Object.assign(forbidden, { preconnect: forbidden }) as typeof fetch;
  const sdk = await import('@oh-my-pi/pi-coding-agent');
  const { initializeExtensions } = await import('@oh-my-pi/pi-coding-agent/modes/runtime-init');
  const manager = sdk.SessionManager.inMemory(root);
  const historical = { customType: 'collab-prompt', content: 'Historical bounded request', display: true, attribution: 'user' as const, details: { from: 'Owned fixture' } };
  manager.appendCustomMessageEntry(historical.customType, historical.content, true, historical.details, 'user');
  const target = { pcId: 'owned', sessionId: manager.getSessionId(), instanceId: crypto.randomUUID() };
  const sentinelReceipts: string[] = [];
  let inputs = 0, management!: ManagementInput, sentinel!: SentinelCorrection;
  const model: Model<'owned-input-proof'> = { id: 'owned', name: 'owned', provider: 'owned-input-proof', api: 'owned-input-proof', compat: undefined, identity: { class: 'unknown' }, baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 32 };
  stage = 'session_create'; console.log(`MANAGEMENT_INPUT_SDK_STAGE=${stage}`);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, 'agent'), settings: sdk.Settings.isolated(), sessionManager: manager, model, getApiKey: async () => 'owned-no-secret', disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], enableMCP: false, enableLsp: false, toolNames: [], extensions: [(pi: ExtensionAPI) => {
    management = new ManagementInput(() => sentinel?.cancelPending());
    management.reset(manager.getEntries());
    sentinel = new SentinelCorrection(pi, () => management.available, target.sessionId, target.instanceId, (id, state) => sentinelReceipts.push(`${id}:${state}`));
    pi.on('input', () => { inputs++; management.advance(); });
    pi.on('message_start', event => { management.observe([event.message]); });
    pi.on('context', event => { management.observe(event.messages); return { messages: sentinel.filter(event.messages) }; });
    pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'owned-no-secret', models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: 32000, maxTokens: 32 }], streamSimple: forbidden });
  }] });
  const correction = () => ({ type: 'sentinel_correction_request' as const, requestId: crypto.randomUUID(), sessionId: target.sessionId, instanceId: target.instanceId, text: 'Owned correction', expiresAt: Date.now() + 60000 });
  try {
    await initializeExtensions(session, { reportSendError: forbidden, reportRuntimeError: forbidden });
    stage = 'public_input'; console.log(`MANAGEMENT_INPUT_SDK_STAGE=${stage}`);
    const runner = session.extensionRunner!;
    expect(management.revision).toBe(0);
    expect(management.observe(structuredClone(manager.getEntries()))).toBe(false);
    expect(management.revision).toBe(0);
    await runner.emitInput('Direct input positive control', undefined, 'interactive');
    expect(inputs).toBe(1); expect(management.revision).toBe(1);
    const staleCorrection = correction();
    sentinel.request(staleCorrection);
    // Public queue-only path is real SDK behavior and must not execute a provider.
    stage = 'queue_context'; console.log(`MANAGEMENT_INPUT_SDK_STAGE=${stage}`);
    await session.promptCustomMessage({ ...historical, content: 'New direct collaboration input' }, { queueOnly: true, streamingBehavior: 'steer' });
    expect(inputs).toBe(1); expect(management.revision).toBe(1);
    const queuedCollab = session.agent.peekSteeringQueue().find(message => 'customType' in message && message.customType === 'collab-prompt' && 'attribution' in message && message.attribution === 'user');
    expect(queuedCollab).toBeDefined();
    const collab = structuredClone(queuedCollab!);
    const correctionMessage: AgentMessage = { role: 'custom', customType: 'sentinel:correction', content: staleCorrection.text, display: true, timestamp: Date.now(), details: { requestId: staleCorrection.requestId, sessionId: target.sessionId, instanceId: target.instanceId } };
    const context = await runner.emitContext(structuredClone([collab, correctionMessage]));
    expect(management.revision).toBe(2);
    expect(context.some(message => 'customType' in message && message.customType === 'sentinel:correction')).toBe(false);
    expect(sentinelReceipts).toContain(`${staleCorrection.requestId}:cancelled`);
    await runner.emitContext(structuredClone([collab])); expect(management.revision).toBe(2);
    await session.promptCustomMessage({ ...historical, content: 'Second direct collaboration input' }, { queueOnly: true, streamingBehavior: 'steer' });
    const nextQueued = session.agent.peekSteeringQueue().find(message => 'customType' in message && message.customType === 'collab-prompt' && 'content' in message && message.content === 'Second direct collaboration input');
    expect(nextQueued).toBeDefined();
    const nextCollab = structuredClone(nextQueued!);
    await runner.emit({ type: 'message_start', message: nextCollab });
    expect(management.revision).toBe(3);
    await runner.emitContext(structuredClone([nextCollab]));
    expect(management.revision).toBe(3);
    console.log('MANAGEMENT_INPUT_SDK_PROOF=passed');
  } finally { sentinel?.close(); await session.dispose(); }
}, 60000);
