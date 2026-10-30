import { expect, test } from "bun:test";
import { SessionBusClient } from "../src/extension/session-bus-client";
import { clientFrameSchema, serverFrameSchema } from "../src/shared/protocol";

// Protocol-peer proof only: Main owns actual broker/native consumer qualification.
test("real client correlates consultation, sends caller cancel, and aborts target on disconnect", async () => {
  const registered = Promise.withResolvers<void>();
  const asked = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const targetStarted = Promise.withResolvers<void>();
  const targetAborted = Promise.withResolvers<void>();
  const relayId = crypto.randomUUID();
  let peer: { send(text: string): unknown; close(): unknown } | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("upgrade required", { status: 400 }); },
    websocket: {
      message(socket, data) {
        peer = socket;
        const frame = clientFrameSchema.parse(JSON.parse(String(data)));
        if (frame.type === "register") socket.send(JSON.stringify(serverFrameSchema.parse({ type: "registered", sessionId: "source", coordinator: true })));
        if (frame.type === "session_inspect" && frame.operation.kind === "history") {
          socket.send(JSON.stringify(serverFrameSchema.parse({ type: "session_inspect_response", requestId: frame.requestId,
            result: { kind: "history", sessionId: frame.to, throughEntryCount: 0, entryIndex: 0, offset: 0, text: "", next: null } })));
        }
        if (frame.type === "session_inspect" && frame.operation.kind === "question") asked.resolve();
        if (frame.type === "session_inspect_cancel") cancelled.resolve();
      },
    },
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const client = new SessionBusClient({
    url: `ws://127.0.0.1:${server.port}/bus`, machineKey: "disposable-test-machine-key-0123456789",
    session: { pcId: "test", sessionId: "source", instanceId: crypto.randomUUID(), name: "test", cwd: "/test", role: "coordinator", idle: true },
    allowSteer: false, onInboundMessage() {},
    onStatusChange(status) { if (status.state === "registered") registered.resolve(); },
    async onInspect(_operation, signal) {
      const stopped = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => { targetAborted.resolve(); stopped.resolve(); }, { once: true });
      targetStarted.resolve();
      await stopped.promise;
      return { kind: "error", code: "cancelled" };
    },
    timers: {
      setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
      clearTimer(timer) { clearTimeout(timer); timers.delete(timer); },
    },
  });
  try {
    client.start();
    await registered.promise;
    expect(await client.inspect("target", { kind: "history", entryIndex: 0, offset: 0 })).toMatchObject({ kind: "history", sessionId: "target", next: null });
    const controller = new AbortController();
    const request = client.inspect("target", { kind: "question", question: "status?" }, controller.signal);
    const rejection = request.then(() => { throw new Error("Expected cancellation"); }, error => error);
    await asked.promise;
    controller.abort();
    expect(await rejection).toMatchObject({ code: "cancelled" });
    await cancelled.promise;
    peer!.send(JSON.stringify(serverFrameSchema.parse({ type: "session_inspect_request", requestId: relayId, operation: { kind: "question", question: "target status?" } })));
    await targetStarted.promise;
    peer!.close();
    await targetAborted.promise;
  } finally {
    client.shutdown();
    for (const timer of timers) clearTimeout(timer);
    server.stop(true);
  }
}, 10_000);
