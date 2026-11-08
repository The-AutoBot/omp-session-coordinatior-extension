import { expect,test } from 'bun:test';
import { mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI,ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { ManagedSessionBridge } from '../src/extension/managed-session';
import { clientFrameSchema } from '../src/shared/protocol';
test('managed lifecycle publishes a real journal and never installs private review hooks',()=>{
 const keys=['OMP_PC_RUNTIME_MANAGED_AGENT','OMP_PC_RUNTIME_LAUNCH_ID','OMP_PC_RUNTIME_CONTROL_DIRECTORY','OMP_PC_RUNTIME_SESSION_DIRECTORY'];const saved=keys.map(k=>process.env[k]);
 const root=realpathSync(mkdtempSync(join(tmpdir(),'managed-lifecycle-')));const control=join(root,'control'),sessions=join(root,'sessions');mkdirSync(control);mkdirSync(sessions);
 const file=join(sessions,'session.jsonl');writeFileSync(file,JSON.stringify({type:'session',id:'owned'})+'\n');
 Object.assign(process.env,{OMP_PC_RUNTIME_MANAGED_AGENT:'sentinel',OMP_PC_RUNTIME_LAUNCH_ID:crypto.randomUUID(),OMP_PC_RUNTIME_CONTROL_DIRECTORY:control,OMP_PC_RUNTIME_SESSION_DIRECTORY:sessions});
 const handlers=new Map<string,(event:never,ctx:ExtensionContext)=>unknown>();
 // Public lifecycle double intentionally excludes generation and tool APIs.
 const pi={on:(name:string,fn:(event:never,ctx:ExtensionContext)=>unknown)=>handlers.set(name,fn),registerCommand:()=>{}} as unknown as ExtensionAPI;
 const ctx={mode:'tui',hasUI:true,sessionManager:{getSessionId:()=> 'owned',getSessionFile:()=>file}} as unknown as ExtensionContext;
 try{const bridge=ManagedSessionBridge.create(pi)!;bridge.install();handlers.get('session_start')!({} as never,ctx);
 expect(JSON.parse(readFileSync(join(control,'session.json'),'utf8'))).toMatchObject({sessionId:'owned',sessionFile:file});
 for(const name of ['context','tool_call','agent_start','agent_end','message_start'])expect(handlers.has(name)).toBe(false);
 expect(bridge.identity(ctx)?.managedAgent).toBe('sentinel');handlers.get('session_shutdown')!({} as never,ctx);
 }finally{keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});rmSync(root,{recursive:true,force:true});}
});

test('project lifecycle shares exact instance identity without Sentinel classification or prompt', () => {
 const keys = ['OMP_PC_RUNTIME_MANAGED_AGENT','OMP_PC_RUNTIME_LAUNCH_ID','OMP_PC_RUNTIME_CONTROL_DIRECTORY','OMP_PC_RUNTIME_SESSION_DIRECTORY'];
 const saved = keys.map(key => process.env[key]);
 const root = realpathSync(mkdtempSync(join(tmpdir(),'managed-project-')));
 const control = join(root,'control'), sessions = join(root,'sessions');
 mkdirSync(control); mkdirSync(sessions);
 const file = join(sessions,'session.jsonl');
 writeFileSync(file,JSON.stringify({type:'session',id:'project'})+'\n');
 Object.assign(process.env,{OMP_PC_RUNTIME_MANAGED_AGENT:'session',OMP_PC_RUNTIME_LAUNCH_ID:crypto.randomUUID(),OMP_PC_RUNTIME_CONTROL_DIRECTORY:control,OMP_PC_RUNTIME_SESSION_DIRECTORY:sessions});
 const handlers = new Map<string,(event:never,ctx:ExtensionContext)=>unknown>();
 const commands: string[] = [];
 const pi = {on:(name:string,fn:(event:never,ctx:ExtensionContext)=>unknown)=>handlers.set(name,fn),registerCommand:(name:string)=>commands.push(name)} as unknown as ExtensionAPI;
 const ctx = {mode:'tui',hasUI:true,sessionManager:{getSessionId:()=> 'project',getSessionFile:()=>file}} as unknown as ExtensionContext;
 try {
  const bridge = ManagedSessionBridge.create(pi)!;
  bridge.install(); handlers.get('session_start')!({} as never,ctx);
  const identity = bridge.identity(ctx)!;
  expect(identity.managedAgent).toBeUndefined();
  expect(bridge.identity(ctx)?.instanceId).toBe(identity.instanceId);
  expect(JSON.parse(readFileSync(join(control,'session.json'),'utf8')).instanceId).toBe(identity.instanceId);
  expect(commands).toEqual(['runtime-bootstrap']);
  expect(handlers.get('before_agent_start')!({systemPrompt:['ordinary']} as never,ctx)).toBeUndefined();
  handlers.get('session_shutdown')!({} as never,ctx);
 } finally {
  keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
  rmSync(root,{recursive:true,force:true});
 }
});

test('manager bootstraps through public newSession and preserves its identity on resume', async () => {
 const keys = ['OMP_PC_RUNTIME_MANAGED_AGENT','OMP_PC_RUNTIME_MANAGER_ID','OMP_PC_RUNTIME_LAUNCH_ID','OMP_PC_RUNTIME_CONTROL_DIRECTORY','OMP_PC_RUNTIME_SESSION_DIRECTORY'];
 const saved = keys.map(key => process.env[key]);
 const root = realpathSync(mkdtempSync(join(tmpdir(),'managed-manager-')));
 const control = join(root,'control'), sessions = join(root,'sessions');
 mkdirSync(control); mkdirSync(sessions);
 const managerId = crypto.randomUUID(), launchId = crypto.randomUUID();
 Object.assign(process.env,{OMP_PC_RUNTIME_MANAGED_AGENT:'manager',OMP_PC_RUNTIME_MANAGER_ID:managerId,OMP_PC_RUNTIME_LAUNCH_ID:launchId,OMP_PC_RUNTIME_CONTROL_DIRECTORY:control,OMP_PC_RUNTIME_SESSION_DIRECTORY:sessions});
 const handlers = new Map<string,(event:never,ctx:ExtensionContext)=>unknown>();
 let bootstrap: ((args:string,ctx:ExtensionContext)=>Promise<void>) | undefined;
 const names: string[] = [];
 const file = join(sessions,'manager.jsonl');
 let currentFile: string | undefined, calls = 0;
 const pi = {on:(name:string,fn:(event:never,ctx:ExtensionContext)=>unknown)=>handlers.set(name,fn),
  registerCommand:(name:string,command:{handler:typeof bootstrap})=>{expect(name).toBe('manager-bootstrap');bootstrap=command.handler;},
  setSessionName:(name:string)=>{names.push(name);}} as unknown as ExtensionAPI;
 const ctx = {mode:'tui',hasUI:true,isIdle:()=>true,hasPendingMessages:()=>false,
  sessionManager:{getSessionId:()=> 'manager',getSessionFile:()=>currentFile,getEntries:()=>[]},
  newSession:async()=>{calls++;writeFileSync(file,JSON.stringify({type:'session',id:'manager'})+'\n');currentFile=file;return {cancelled:false};}} as unknown as ExtensionContext;
 process.argv.push('/manager-bootstrap');
 try {
  const bridge = ManagedSessionBridge.create(pi)!;
  bridge.install(); await bootstrap!('',ctx);
  expect(calls).toBe(1); expect(names).toEqual(['Manager']);
  handlers.get('session_start')!({} as never,ctx);
  const identity = bridge.identity(ctx)!;
  expect(identity).toMatchObject({managedAgent:'manager',managerId,launchId});
  expect(JSON.parse(readFileSync(join(control,'session.json'),'utf8'))).toMatchObject({managerId,launchId,instanceId:identity.instanceId,sessionFile:file});
  const guidance = handlers.get('before_agent_start')!({systemPrompt:['ordinary']} as never,ctx);
  expect(guidance).toMatchObject({systemPrompt:expect.arrayContaining([expect.stringContaining('Use session_manager')])});
  await bootstrap!('',ctx); handlers.get('session_switch')!({} as never,ctx);
  expect(calls).toBe(1); expect(names).toEqual(['Manager']);
  const challenge = { kind: 'bind_challenge', managerId, launchId, sessionId: 'manager', instanceId: identity.instanceId,
    connectionId: crypto.randomUUID(), runtimeLeaseId: crypto.randomUUID(), challengeId: crypto.randomUUID(), nonce: 'a'.repeat(64), expiresAt: Date.now() + 30_000 };
  let proofs = 0;
  writeFileSync(join(control, 'manager-bind.json'), JSON.stringify({ ...challenge, instanceId: crypto.randomUUID() }));
  bridge.attachProof(() => { proofs++; return true; });
  expect(proofs).toBe(0);
  writeFileSync(join(control, 'manager-bind.json'), JSON.stringify(challenge));
  bridge.attachProof(c => { expect(c.connectionId).toBe(challenge.connectionId); proofs++; return true; });
  bridge.attachProof(() => { proofs++; return true; });
  expect(proofs).toBe(1);
  bridge.consumeProof(crypto.randomUUID());
  expect(JSON.parse(readFileSync(join(control, 'manager-bind.json'), 'utf8')).challengeId).toBe(challenge.challengeId);
  bridge.consumeProof(challenge.challengeId);
  handlers.get('session_shutdown')!({} as never,ctx);
 } finally {
  process.argv.splice(process.argv.lastIndexOf('/manager-bootstrap'),1);
  keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
  rmSync(root,{recursive:true,force:true});
 }
});

test('manager registration requires explicit protocol capability and complete identity', () => {
 const session = {pcId:'owned',sessionId:'manager',instanceId:crypto.randomUUID(),name:'Manager',cwd:'D:/owned',role:'participant',managedAgent:'manager',idle:true,connectedAt:new Date().toISOString()};
 const frame = {type:'register',session,managementProtocol:1,allowSteer:false,inputRevision:0,pendingToolApproval:false,managerId:crypto.randomUUID(),launchId:crypto.randomUUID()};
 expect(clientFrameSchema.safeParse(frame).success).toBe(true);
 for (const key of ['managementProtocol','allowSteer','inputRevision','pendingToolApproval','managerId','launchId']) {
  const incomplete: Record<string,unknown> = {...frame};
  delete incomplete[key];
  expect(clientFrameSchema.safeParse(incomplete).success).toBe(false);
 }
 expect(clientFrameSchema.safeParse({...frame,inputRevision:-1}).success).toBe(false);
 expect(clientFrameSchema.safeParse({...frame,inputRevision:Number.MAX_SAFE_INTEGER+1}).success).toBe(false);
 expect(clientFrameSchema.safeParse({type:'register',session:{...session,managedAgent:undefined}}).success).toBe(true);
});
