import assert from "node:assert/strict";
import { SessionBusClient } from "@autobot/omp-session-coordinator-extension/session-bus-client";
import extension, { resolveSessionDisplayName } from "@autobot/omp-session-coordinator-extension";
import { clientFrameSchema, serverFrameSchema } from "../src/shared/protocol";

// A real loopback WebSocket peer speaking the broker's validated public wire protocol.
// This is a client/package consumer proof, not a replacement for server broker integration tests.
assert.equal(typeof extension, "function");
assert.equal(typeof resolveSessionDisplayName, "function");
const key = "disposable-loopback-smoke-key-0123456789";
let authenticated = false;
let listed = false;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    authenticated = request.headers.get("authorization") === `Bearer ${key}` &&
      request.headers.get("x-omp-pc-id") === "smoke";
    if (authenticated && server.upgrade(request)) return undefined;
    return new Response("unauthorized", { status: 401 });
  },
  websocket: {
    message(socket, data) {
      const frame = clientFrameSchema.parse(JSON.parse(String(data)));
      if (frame.type === "register") {
        socket.send(JSON.stringify(serverFrameSchema.parse({ type: "registered", sessionId: frame.session.sessionId, coordinator: false })));
      } else if (frame.type === "list") {
        listed = true;
        socket.send(JSON.stringify(serverFrameSchema.parse({ type: "sessions", requestId: frame.requestId, sessions: [] })));
      }
    },
  },
});
const timers = new Set<ReturnType<typeof setTimeout>>();
const client = new SessionBusClient({
  url: `ws://127.0.0.1:${server.port}/bus`, machineKey: key,
  session: { pcId: "smoke", sessionId: "consumer-smoke", instanceId: crypto.randomUUID(), name: "Smoke", role: "participant", cwd: "/disposable", idle: true },
  allowSteer: false,
  timers: {
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimer(timer) { clearTimeout(timer); timers.delete(timer); },
  },
  onInboundMessage() {},
});
try {
  client.start();
  const deadline = Date.now() + 5000;
  while (client.getStatus().state !== "registered") {
    assert.ok(Date.now() < deadline, "client registration timed out");
    await Bun.sleep(10);
  }
  assert.deepEqual(await client.listSessions(), []);
  assert.ok(authenticated && listed);
  console.log("PASS package exports, authenticated real loopback registration and list request/response");
} finally {
  client.shutdown();
  for (const timer of timers) clearTimeout(timer);
  server.stop(true);
}
