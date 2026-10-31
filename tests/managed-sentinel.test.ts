import { expect,test } from 'bun:test';
import { mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI,ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { ManagedSessionBridge } from '../src/extension/managed-session';
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
