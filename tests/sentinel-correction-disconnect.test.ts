import { test, expect } from 'bun:test';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { SessionBusClient } from '../src/extension/session-bus-client';
import { SentinelCorrection } from '../src/extension/sentinel-correction';
import { clientFrameSchema, serverFrameSchema } from '../src/shared/protocol';

test('connection loss revokes a pending correction before any later context boundary', async () => {
  const sessionId=crypto.randomUUID(),instanceId=crypto.randomUUID(),requestId=crypto.randomUUID();
  const disconnected=Promise.withResolvers<void>(),payloads:unknown[]=[],receipts:string[]=[];
  let received=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request,server){if(server.upgrade(request))return;return new Response(null,{status:400});},websocket:{message(socket,data){
    const frame=clientFrameSchema.parse(JSON.parse(String(data)));
    if(frame.type==='register'){
      socket.send(JSON.stringify(serverFrameSchema.parse({type:'registered',sessionId,coordinator:false})));
      socket.send(JSON.stringify(serverFrameSchema.parse({type:'sentinel_correction_request',requestId,sessionId,instanceId,text:'A correction owned by this connection only',expiresAt:Date.now()+30_000})));
      socket.close();
    }
  }}});
  const timers=new Set<Timer>();
  let client:SessionBusClient<Timer>;
  // Only native enqueue is controlled; the real transport and production context gate are exercised.
  const pi={sendMessage(message:unknown){payloads.push(message);}} as unknown as ExtensionAPI;
  const handler=new SentinelCorrection(pi,()=>true,sessionId,instanceId,(id,status)=>{receipts.push(status);client.correctionResult(id,status);});
  client=new SessionBusClient({url:`ws://127.0.0.1:${server.port}`,machineKey:'owned-disconnect-key-0123456789',session:{pcId:'owned',sessionId,instanceId,name:'owned',cwd:'/owned',role:'participant',idle:false},allowSteer:false,interactiveRoot:true,
    onInboundMessage(){throw Error('Unexpected generic message');},onCorrection(request){received=true;handler.request(request);},onCorrectionCancel(id){handler.cancel(id);},
    onStatusChange(status){if(received&&status.state==='disconnected')disconnected.resolve();},
    timers:{setTimeout(callback,delay){const timer=setTimeout(callback,delay);timers.add(timer);return timer;},clearTimer(timer){clearTimeout(timer);timers.delete(timer);}}});
  try{
    client.start();await disconnected.promise;
    expect(handler.filter(payloads)).toEqual([]);
    expect(receipts).toContain('cancelled');
    expect(receipts).not.toContain('context_admitted');
  }finally{handler.close();client.shutdown();for(const timer of timers)clearTimeout(timer);await server.stop(true);}
},10_000);
