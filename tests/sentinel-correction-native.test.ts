import { test, expect } from 'bun:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SentinelCorrection } from '../src/extension/sentinel-correction';

// Opt-in installed SDK qualification, not a synthetic context event fixture.
const sdkRoot = process.env.OMP_NATIVE_CORRECTION_SDK;
test.skipIf(!sdkRoot)('actual SDK context admits dedicated corrections and rejects revoked authority', async () => {
  if (process.env.SENTINEL_CORRECTION_NATIVE_CHILD !== '1') {
    const ownedRoot = await mkdtemp(join(tmpdir(), 'sentinel-native-'));
    const child = Bun.spawn([process.execPath, 'test', fileURLToPath(import.meta.url)], {
      env: { ...process.env, SENTINEL_CORRECTION_NATIVE_CHILD: '1', SENTINEL_CORRECTION_NATIVE_ROOT: ownedRoot,
        HOME: ownedRoot, USERPROFILE: ownedRoot, APPDATA: join(ownedRoot, 'AppData/Roaming'), LOCALAPPDATA: join(ownedRoot, 'AppData/Local') },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (exit !== 0) throw Error(`Owned native consumer failed (${exit}): ${stdout}\n${stderr}`);
      expect(exit).toBe(0);
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
      await rm(ownedRoot, { recursive: true, force: true });
    }
    return;
  }
  const root = process.env.SENTINEL_CORRECTION_NATIVE_ROOT!;
  for (const key of Object.keys(process.env)) if (/^(?:OMP_|PI_|ANTHROPIC|OPENAI|GOOGLE|GEMINI|AZURE|AWS|GITHUB_TOKEN|GH_TOKEN)/.test(key)) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  globalThis.fetch = Object.assign(() => { throw Error('Owned native consumer forbids network'); }, { preconnect: () => { throw Error('Owned native consumer forbids network'); } }) as typeof fetch;
  const sdk = await import(sdkRoot + '/src/index.ts');
  const { initializeExtensions } = await import(sdkRoot + '/src/modes/runtime-init.ts');
  const sessionId = crypto.randomUUID(), instanceId = crypto.randomUUID();
  const receipts: string[] = [], contexts: string[] = [];
  let current = true;
  let boundaryNow: number | undefined;
  let handler: SentinelCorrection | undefined;
  const model = { id:'owned', name:'owned', provider:'owned-sentinel-test', api:'owned-sentinel-test', identity:{class:'unknown'}, baseUrl:'http://127.0.0.1:1', reasoning:false, input:['text'] as ('text' | 'image')[], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:32000,maxTokens:32 };
  const { session } = await sdk.createAgentSession({cwd:root,agentDir:join(root,'agent'),settings:sdk.Settings.isolated(),sessionManager:sdk.SessionManager.inMemory(root),model,getApiKey:async()=> 'owned-no-secret',bindProcessState:false,disableExtensionDiscovery:true,skills:[],rules:[],contextFiles:[],noContextFiles:true,promptTemplates:[],slashCommands:[],mcpTools:[],enableLsp:false,toolNames:[],restrictTools:true,extensions:[(pi: ExtensionAPI)=> {
    handler = new SentinelCorrection(pi,()=>current,sessionId,instanceId,(id,status)=>receipts.push(id+':'+status));
    pi.on('context',event=>{
      const originalNow = Date.now;
      try {
        if (boundaryNow !== undefined) Date.now = () => boundaryNow!;
        return {messages:handler!.filter(event.messages)};
      } finally { Date.now = originalNow; }
    });
    pi.registerProvider(model.provider,{api:model.api,baseUrl:model.baseUrl,apiKey:'owned-no-secret',models:[model],streamSimple:(_model,context)=>{contexts.push(JSON.stringify(context.messages));throw new Error('OWNED_BOUNDARY_REACHED');}});
  }]});
  try {
    await initializeExtensions(session,{reportSendError:()=>{},reportRuntimeError:()=>{}});
    const request = (text:string, expiresAt=Date.now()+60_000) => ({type:'sentinel_correction_request' as const,requestId:crypto.randomUUID(),sessionId,instanceId,text,expiresAt});
    const admitted=request('Sentinel agent correction; authority unchanged');
    const cancelled=request('MUST_NOT_CANCELLED'); const expired=request('MUST_NOT_EXPIRED',Date.now()-1);
    handler!.request(admitted); handler!.request(admitted);
    handler!.request(cancelled); handler!.cancel(cancelled.requestId); handler!.request(expired);
    expect(receipts).not.toContain(admitted.requestId+':context_admitted');
    await session.prompt('owned native boundary').catch(()=>{});
    expect(contexts).toHaveLength(1);
    expect(receipts.filter(value=>value===admitted.requestId+':context_admitted')).toHaveLength(1);
    expect(receipts).toContain(cancelled.requestId+':cancelled'); expect(receipts).toContain(expired.requestId+':expired');
    expect(contexts.at(-1)).toContain(admitted.text); expect(contexts.at(-1)).not.toContain('MUST_NOT_');
    handler!.cancel(admitted.requestId); handler!.request(admitted);
    expect(receipts.at(-1)).toBe(admitted.requestId+':context_admitted');
    const ttl = request('MUST_NOT_TTL');
    handler!.request(ttl);
    boundaryNow = ttl.expiresAt + 1;
    await session.prompt('owned expiry boundary').catch(()=>{});
    expect(contexts).toHaveLength(2);
    boundaryNow = undefined;
    expect(receipts).toContain(ttl.requestId+':expired');
    expect(contexts.at(-1)).not.toContain(ttl.text);
    const replaced=request('MUST_NOT_REPLACED'); handler!.request(replaced); current=false;
    await session.prompt('owned replacement boundary').catch(()=>{});
    expect(contexts).toHaveLength(3);
    expect(receipts).toContain(replaced.requestId+':unavailable');
    expect(contexts.at(-1)).not.toContain(admitted.text); expect(contexts.at(-1)).not.toContain(replaced.text);
  } finally {handler?.close(); await session.dispose();}
},60_000);
