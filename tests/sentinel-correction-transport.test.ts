import { test, expect } from 'bun:test';
import { SessionBusClient } from '../src/extension/session-bus-client';
import { clientFrameSchema, serverFrameSchema } from '../src/shared/protocol';

// Complement to actual native context tests: wire transport is not admission proof.
test('dedicated correction lane works with general steering disabled; receipt is explicit', async () => {
  const received = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  const requestId = crypto.randomUUID(), sessionId = crypto.randomUUID(), instanceId = crypto.randomUUID();
  let generic = 0;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,
    fetch(request,server) {if(server.upgrade(request)) return; return new Response('upgrade',{status:400});},
    websocket:{message(socket,data) {
      const frame=clientFrameSchema.parse(JSON.parse(String(data)));
      if(frame.type==='register') {
        expect(frame.sentinelCorrectionAvailable).toBe(true);
        socket.send(JSON.stringify(serverFrameSchema.parse({type:'registered',sessionId,coordinator:false})));
        socket.send(JSON.stringify(serverFrameSchema.parse({type:'sentinel_correction_request',requestId,sessionId,instanceId,text:'Sentinel correction',expiresAt:Date.now()+30_000})));
        socket.send(JSON.stringify(serverFrameSchema.parse({type:'sentinel_correction_cancel',requestId})));
      }
      if(frame.type==='sentinel_correction_result') result.resolve(frame.status);
    }}});
  const timers = new Set<Timer>();
  const client=new SessionBusClient({url:`ws://127.0.0.1:${server.port}`,machineKey:'owned-correction-key-0123456789',
    session:{pcId:'owned',sessionId,instanceId,name:'owned',cwd:'/owned',role:'participant',idle:true},allowSteer:false,interactiveRoot:true,
    onInboundMessage(){generic++;},onCorrection(request){expect(request.requestId).toBe(requestId);received.resolve();},
    onCorrectionCancel(id){expect(id).toBe(requestId);cancelled.resolve();},
    timers:{setTimeout(callback,delay){const timer=setTimeout(callback,delay);timers.add(timer);return timer;},clearTimer(timer){clearTimeout(timer);timers.delete(timer);}}});
  try {client.start();await received.promise;await cancelled.promise;expect(generic).toBe(0);
    // Merely receiving/enqueuing never emits a receipt; only the native owner calls this.
    client.correctionResult(requestId,'cancelled');expect(await result.promise).toBe('cancelled');
  }finally{client.shutdown();for(const timer of timers)clearTimeout(timer);server.stop(true);}
},10_000);
