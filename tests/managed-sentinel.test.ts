import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ManagedSentinelBridge } from "../src/extension/managed-sentinel";

// Real fs.watch delivery exercises atomic control records without model/native
// process calls; production has no repeating filesystem polling fallback.
type Handler = (event: never, ctx: ExtensionContext) => unknown;
const environment = ["OMP_PC_RUNTIME_MANAGED_AGENT", "OMP_PC_RUNTIME_LAUNCH_ID", "OMP_PC_RUNTIME_CONTROL_DIRECTORY", "OMP_PC_RUNTIME_SESSION_DIRECTORY"] as const;
function nativeJournal(id: string, titleSlot = true): string {
  const header = JSON.stringify({type:"session",id}) + "\n";
  if (!titleSlot) return header;
  const title = {type:"title",v:1,title:"Sentinel 尾🙂",source:"user",updatedAt:new Date().toISOString(),pad:""};
  title.pad = " ".repeat(256 - Buffer.byteLength(JSON.stringify(title) + "\n"));
  return JSON.stringify(title) + "\n" + header;
}
function fixture(blank = false, titleSlot = true) {
  const saved = environment.map(key => process.env[key]);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-sentinel-")));
  const control = join(root, "control"), sessions = join(root, "sessions");
  mkdirSync(control); mkdirSync(sessions);
  const launchId = crypto.randomUUID();
  process.env.OMP_PC_RUNTIME_MANAGED_AGENT = "sentinel";
  process.env.OMP_PC_RUNTIME_LAUNCH_ID = launchId;
  process.env.OMP_PC_RUNTIME_CONTROL_DIRECTORY = control;
  process.env.OMP_PC_RUNTIME_SESSION_DIRECTORY = sessions;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const messages: { message: unknown; options: unknown }[] = [];
  let sessionId = "native-session", file: string | undefined = blank ? undefined : join(sessions, "native.jsonl");
  if (file) writeFileSync(file, nativeJournal(sessionId, titleSlot));
  let idle = true, pending = false, aborts = 0, shutdowns = 0, newSessions = 0;
  // Deliberately partial public native double: no private mutation API is supplied.
  const ctx = { mode: "tui", hasUI: true, isIdle: () => idle, hasPendingMessages: () => pending,
    abort: () => { aborts++; }, shutdown: () => { shutdowns++; },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file,
      getEntries: () => blank ? [{ type: "model_change" }, { type: "thinking_level_change" }, { type: "service_tier_change" }] : [] },
    newSession: async () => {
      newSessions++; sessionId = "bootstrapped-session"; file = join(sessions, "bootstrapped.jsonl");
      writeFileSync(file, nativeJournal(sessionId, titleSlot));
      emit("session_switch"); return { cancelled: false };
    },
  } as unknown as ExtensionContext;
  const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    sendMessage: (message: unknown, options: unknown) => { messages.push({ message, options }); },
    setSessionName: async (_name: string) => {},
  } as unknown as ExtensionAPI;
  function emit(name: string, event: unknown = {}) { return handlers.get(name)?.map(handler => handler(event as never, ctx)); }
  const bridge = ManagedSentinelBridge.create(pi)!;
  bridge.install(); emit("session_start");
  const write = (name: string, value: unknown) => {
    const temporary = join(control, `.${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, join(control, name));
  };
  const metadata = () => JSON.parse(readFileSync(join(control, "session.json"), "utf8")) as { sessionId: string; instanceId: string; sessionFile: string };
  const response = () => JSON.parse(readFileSync(join(control, "response.json"), "utf8")) as { requestId: string; status: string; text?: string };
  const readiness = () => JSON.parse(readFileSync(join(control, "readiness.json"), "utf8")) as {
    version: number; probeId: string; sessionId: string; instanceId: string; expiresAt: number;
    activeRequestId: string | null; generationRequestId: string | null; nativeIdle: boolean;
    pendingMessages: boolean; observedRequestId: string | null;
  };
  const probe = (changes: object = {}) => {
    const binding = metadata();
    const value = { version: 2, launchId, probeId: crypto.randomUUID(), sessionId: binding.sessionId,
      instanceId: binding.instanceId, expiresAt: Date.now() + 5_000, ...changes };
    write("probe.json", value); return value;
  };
  const request = (changes: object = {}) => {
    const binding = metadata();
    const value = { version: 1, launchId, requestId: crypto.randomUUID(), sessionId: binding.sessionId,
      instanceId: binding.instanceId, expiresAt: Date.now() + 30_000, prompt: "Return the review JSON plan.", ...changes };
    write("request.json", value); return value;
  };
  return { root, control, sessions, launchId, ctx, pi, bridge, emit, messages, commands, metadata, response, readiness, probe, request, write,
    busy: (value = true) => { idle = !value; }, pending: (value = true) => { pending = value; },
    counts: () => ({ aborts, shutdowns, newSessions }),
    replace: (outside = false, event = "session_switch", valid: boolean | string = true) => {
      sessionId = "human-replacement"; file = join(outside ? root : sessions, "human.jsonl");
      writeFileSync(file, valid === true ? nativeJournal(sessionId, titleSlot) :
        (typeof valid === "string" ? valid : "{}\n") + nativeJournal(sessionId, false));
      emit(event);
    },
    close: () => {
      emit("session_shutdown"); rmSync(root, { recursive: true, force: true });
      environment.forEach((key, index) => { const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    },
  };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!condition()) { if (Date.now() >= deadline) throw new Error("bridge condition timed out"); await Bun.sleep(10); }
}
function completed(f: { emit(name: string, event: unknown): unknown }, text = '{"findings":[]}') {
  f.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] });
}

describe("owned Sentinel native file bridge", () => {
  it("does nothing for ordinary sessions, regardless of their name", () => {
    const saved = process.env.OMP_PC_RUNTIME_MANAGED_AGENT;
    delete process.env.OMP_PC_RUNTIME_MANAGED_AGENT;
    try { expect(ManagedSentinelBridge.create({} as ExtensionAPI)).toBeUndefined(); }
    finally { if (saved !== undefined) process.env.OMP_PC_RUNTIME_MANAGED_AGENT = saved; }
  });

  it("publishes actual identity and returns only the final native assistant after an owned turn", async () => {
    const f = fixture();
    try {
      expect(f.metadata()).toMatchObject({ sessionId: "native-session", sessionFile: join(f.sessions, "native.jsonl") });
      expect(f.bridge.identity(f.ctx)?.instanceId).toBe(f.metadata().instanceId);
      const request = f.request();
      await until(() => f.messages.length === 1);
      expect(f.messages[0]).toMatchObject({ message: { customType: "sentinel:review", display: false }, options: { triggerTurn: true } });
      f.emit("agent_start");
      expect(f.emit("tool_call", { toolName: "bash" })?.[0]).toMatchObject({ block: true });
      f.emit("agent_end", { willContinue: true, messages: [{ role: "assistant", content: [{ type: "text", text: "intermediate" }] }] });
      completed(f);
      expect(f.response()).toMatchObject({ requestId: request.requestId, status: "completed", text: '{"findings":[]}' });
      expect(f.emit("tool_call", { toolName: "bash" })?.[0]).toBeUndefined();
      const persona = f.emit("before_agent_start", { systemPrompt: ["ordinary tools"] })?.[0];
      expect(persona).toMatchObject({ systemPrompt: ["ordinary tools", expect.stringContaining("You are Sentinel")] });
      await Bun.sleep(550); expect(f.messages).toHaveLength(1);
    } finally { f.close(); }
  });

  it("answers bounded identity-bound readiness probes without a model turn or recurring writes", async () => {
    const f = fixture();
    try {
      const journal = readFileSync(f.metadata().sessionFile, "utf8");
      const probe = f.probe();
      await until(() => { try { return f.readiness().probeId === probe.probeId; } catch { return false; } });
      expect(f.readiness()).toMatchObject({ version: 2, probeId: probe.probeId, expiresAt: probe.expiresAt,
        sessionId: probe.sessionId, instanceId: probe.instanceId, activeRequestId: null,
        generationRequestId: null, nativeIdle: true, pendingMessages: false, observedRequestId: null });
      expect(f.messages).toHaveLength(0);
      const stamp = statSync(join(f.control, "readiness.json"), { bigint: true });
      f.write("unrelated.json", {});
      // Exercise absence of the former real 500ms platform fallback, not a
      // debounce; fake timers cannot drive the OS watcher that receives writes.
      await Bun.sleep(550);
      expect(statSync(join(f.control, "readiness.json"), { bigint: true }).mtimeNs).toBe(stamp.mtimeNs);
      expect(readFileSync(f.metadata().sessionFile, "utf8")).toBe(journal);
      f.busy(); f.pending();
      const busy = f.probe();
      await until(() => f.readiness().probeId === busy.probeId);
      expect(f.readiness()).toMatchObject({ nativeIdle: false, pendingMessages: true });
      expect(f.messages).toHaveLength(0); expect(f.counts().aborts).toBe(0);
    } finally { f.close(); }
  });

  it("rejects wrong-identity, expired, overlong and malformed readiness probes", async () => {
    const f = fixture();
    try {
      const first = f.probe();
      await until(() => { try { return f.readiness().probeId === first.probeId; } catch { return false; } });
      f.busy();
      for (const changes of [{ launchId: crypto.randomUUID() }, { sessionId: "other" }, { instanceId: crypto.randomUUID() },
        { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 30_000 }, { version: 1 }, { extra: true }]) {
        f.probe(changes);
        // A rejected busy request is a no-model barrier through the same scan;
        // wait for its actual ACK instead of guessing OS watcher latency.
        const barrier = f.request();
        await until(() => { try { return f.response().requestId === barrier.requestId; } catch { return false; } });
        expect(f.readiness().probeId).toBe(first.probeId);
      }
      f.busy(false);
      const final = f.probe();
      await until(() => f.readiness().probeId === final.probeId);
      expect(f.messages).toHaveLength(0);
    } finally { f.close(); }
  });

  it("keeps cancelled generations busy after ACK until public native settlement", async () => {
    const f = fixture();
    try {
      const request = f.request(); await until(() => f.messages.length === 1);
      f.emit("agent_start"); f.busy();
      f.write("cancel.json", { version: 1, launchId: f.launchId, requestId: request.requestId });
      await until(() => { try { return f.response().status === "cancelled"; } catch { return false; } });
      const probe = f.probe({ reconcileRequestId: request.requestId });
      await until(() => { try { return f.readiness().probeId === probe.probeId; } catch { return false; } });
      expect(f.readiness()).toMatchObject({ activeRequestId: null, generationRequestId: request.requestId,
        nativeIdle: false, pendingMessages: false, observedRequestId: request.requestId });
      f.busy(false); f.pending();
      const queued = f.probe();
      await until(() => f.readiness().probeId === queued.probeId);
      expect(f.readiness()).toMatchObject({ generationRequestId: request.requestId, nativeIdle: true, pendingMessages: true });
      f.pending(false);
      const settled = f.probe({ reconcileRequestId: request.requestId });
      await until(() => f.readiness().probeId === settled.probeId);
      expect(f.readiness()).toMatchObject({ activeRequestId: null, generationRequestId: null, nativeIdle: true, pendingMessages: false });
      expect(f.counts().aborts).toBe(0); expect(f.messages).toHaveLength(1);
    } finally { f.close(); }
  });

  it("does not release a cancelled not-yet-started submission from an idle snapshot", async () => {
    const f = fixture();
    try {
      const request = f.request(); await until(() => f.messages.length === 1);
      f.write("cancel.json", { version: 1, launchId: f.launchId, requestId: request.requestId });
      await until(() => { try { return f.response().status === "cancelled"; } catch { return false; } });
      const beforeStart = f.probe();
      await until(() => { try { return f.readiness().probeId === beforeStart.probeId; } catch { return false; } });
      expect(f.readiness()).toMatchObject({ generationRequestId: request.requestId, nativeIdle: true });
      f.emit("agent_start"); completed(f);
      const settled = f.probe();
      await until(() => f.readiness().probeId === settled.probeId);
      expect(f.readiness().generationRequestId).toBeNull();
      expect(f.counts().aborts).toBe(0);
    } finally { f.close(); }
  });

  it("isolates only prior exact hidden automated inputs during scheduled model context", async () => {
    const f = fixture();
    try {
      const journal = readFileSync(f.metadata().sessionFile, "utf8");
      const old = { role: "custom", customType: "sentinel:review", display: false, content: "Old full snapshot",
        details: { requestId: crypto.randomUUID() }, attribution: "agent" };
      const retained = [
        { role: "user", content: '{"findings":[]}' },
        { role: "user", content: [{ type: "image", data: "human-image" }] },
        { ...old, customType: "foreign" }, { ...old, display: true }, { ...old, attribution: "user" },
        { ...old, details: { requestId: "not-a-uuid" } }, { ...old, details: { ...old.details, foreign: true } },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "retained output" }] },
        { role: "assistant", content: [{ type: "text", text: '{"findings":[]}' }] },
      ];
      expect(f.emit("context", { messages: [old, ...retained] })?.[0]).toBeUndefined();
      const request = f.request(); await until(() => f.messages.length === 1); f.emit("agent_start");
      const current = { ...old, content: "Current full snapshot", details: { requestId: request.requestId } };
      const messages = [old, ...retained, current];
      const original = structuredClone(messages);
      expect(f.emit("context", { messages })?.[0]).toEqual({ messages: [...retained, current] });
      expect(messages).toEqual(original);
      expect(readFileSync(f.metadata().sessionFile, "utf8")).toBe(journal);
      f.emit("input", { text: "Human correction", source: "interactive" });
      expect(f.emit("context", { messages })?.[0]).toBeUndefined();
      f.emit("message_start", { message: { role: "user", content: "Human correction" } });
      expect(f.emit("tool_call", { toolName: "read" })?.[0]).toBeUndefined();
      completed(f);
      expect(f.emit("context", { messages })?.[0]).toBeUndefined();
      expect(f.counts().aborts).toBe(0);
    } finally { f.close(); }
  });

  it("defers busy work and rejects foreign, stale, expired, extra-field and oversized records", async () => {
    const f = fixture();
    try {
      f.busy(); const busy = f.request();
      await until(() => { try { return f.response().requestId === busy.requestId; } catch { return false; } });
      expect(f.response().status).toBe("busy"); f.busy(false);
      for (const changes of [{ launchId: crypto.randomUUID() }, { instanceId: crypto.randomUUID() },
        { sessionId: "foreign" }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 300_000 }, { extra: true }]) {
        f.request(changes); await Bun.sleep(550);
      }
      f.write("request.json", { prompt: "x".repeat(8 * 1024 * 1024 + 1) }); await Bun.sleep(550);
      expect(f.messages).toHaveLength(0);
      f.request(); await until(() => f.messages.length === 1);
    } finally { f.close(); }
  });

  it("fences remote human custom input and peer input without aborting or claiming their answer", async () => {
    for (const source of ["collab", "peer", "interactive", "queued"]) {
      const f = fixture();
      try {
        const request = f.request(); await until(() => f.messages.length === 1); f.emit("agent_start");
        if (source === "collab") f.emit("message_start", { message: { role: "custom", customType: "collab-prompt", content: "Human question" } });
        if (source === "peer") f.bridge.invalidate();
        if (source === "interactive") f.emit("input", { text: "Human question", source: "interactive" });
        if (source === "queued") f.pending();
        completed(f, "Human answer is not a scheduled result");
        expect(f.response()).toMatchObject({ requestId: request.requestId, status: "cancelled" });
        expect(f.response().text).toBeUndefined(); expect(f.counts().aborts).toBe(0);
        if (source === "collab") expect(f.emit("tool_call", { toolName: "write" })?.[0]).toBeUndefined();
      } finally { f.close(); }
    }
  });

  it("cancels review authority without aborting native input, ignores foreign shutdown and fences replacement", async () => {
    const f = fixture();
    try {
      const request = f.request(); await until(() => f.messages.length === 1); f.emit("agent_start");
      f.write("cancel.json", { version: 1, launchId: crypto.randomUUID(), requestId: request.requestId });
      await Bun.sleep(550); expect(f.counts().aborts).toBe(0);
      f.write("cancel.json", { version: 1, launchId: f.launchId, requestId: request.requestId });
      await until(() => { try { return f.response().status === "cancelled"; } catch { return false; } });
      expect(f.counts().aborts).toBe(0);
      expect(f.emit("tool_call", { toolName: "write" })?.[0]).toMatchObject({ block: true });
      const deferred = f.request();
      await until(() => f.response().requestId === deferred.requestId);
      expect(f.response().status).toBe("busy");
      f.write("shutdown.json", { version: 1, launchId: crypto.randomUUID() }); await Bun.sleep(550);
      expect(f.counts().shutdowns).toBe(0);
      f.replace(true); expect(f.bridge.identity(f.ctx)).toBeUndefined();
      completed(f, "Foreign replacement answer"); expect(f.response().text).toBeUndefined();
      f.write("shutdown.json", { version: 1, launchId: f.launchId }); await Bun.sleep(550);
      expect(f.counts().shutdowns).toBe(0);
    } finally { f.close(); }
  });

  it("rebinds owned /new, resume and branch journals while cancelling old scheduled authority", async () => {
    for (const event of ["session_switch", "session_branch"]) {
      const f = fixture();
      try {
        const before = f.metadata();
        const oldRequest = f.request(); await until(() => f.messages.length === 1); f.emit("agent_start");
        f.replace(false, event);
        const after = f.metadata();
        expect(after.sessionId).toBe("human-replacement");
        expect(after.instanceId).not.toBe(before.instanceId);
        expect(f.bridge.identity(f.ctx)?.instanceId).toBe(after.instanceId);
        expect(f.response()).toMatchObject({requestId:oldRequest.requestId,status:"cancelled",sessionId:before.sessionId,instanceId:before.instanceId});
        expect(f.counts().aborts).toBe(0);
        expect(f.emit("tool_call", {toolName:"write"})?.[0]).toBeUndefined();
        completed(f, "Old session answer must not be attributed to the replacement");
        expect(f.response().text).toBeUndefined();
        const next = f.request(); await until(() => f.messages.length === 2); f.emit("agent_start"); completed(f);
        expect(f.response()).toMatchObject({requestId:next.requestId,status:"completed",sessionId:after.sessionId,instanceId:after.instanceId});
      } finally { f.close(); }
    }
  });

  it("accepts legacy header-first journals without treating arbitrary prefixes as native title slots", () => {
    const legacy = fixture(false, false);
    try { expect(legacy.metadata().sessionId).toBe("native-session"); }
    finally { legacy.close(); }
    for (const prefix of ["{}\n", JSON.stringify({type:"title",v:1,title:"Sentinel",updatedAt:"now",pad:""}) + "\n",
      JSON.stringify({type:"title",v:2,title:"Sentinel",updatedAt:"now",pad:""}) + "\n"]) {
      const f = fixture();
      try {
        f.replace(false, "session_switch", prefix);
        expect(f.bridge.identity(f.ctx)).toBeUndefined();
        expect(() => f.metadata()).toThrow();
      } finally { f.close(); }
    }
  });

  it("does not publish a synthesized or mismatched journal on an owned-root replacement", () => {
    const f = fixture();
    try {
      f.replace(false, "session_switch", false);
      expect(f.bridge.identity(f.ctx)).toBeUndefined();
      expect(() => f.metadata()).toThrow();
      expect(f.counts().aborts).toBe(0);
    } finally { f.close(); }
  });

  it("shuts down only the current nonce-bound owned native process", async () => {
    const f = fixture();
    try {
      f.write("shutdown.json", { version: 1, launchId: f.launchId });
      await until(() => f.counts().shutdowns === 1);
      expect(f.counts().aborts).toBe(0);
    } finally { f.close(); }
  });

  it("bootstraps only an owned blank positional first launch and never resets resumed sessions", async () => {
    const original = [...process.argv]; process.argv.push("/sentinel-bootstrap");
    try {
      const fresh = fixture(true);
      try {
        await fresh.commands.get("sentinel-bootstrap")!.handler("", fresh.ctx);
        expect(fresh.counts().newSessions).toBe(1); expect(fresh.metadata().sessionId).toBe("bootstrapped-session");
        await fresh.commands.get("sentinel-bootstrap")!.handler("", fresh.ctx);
        expect(fresh.counts().newSessions).toBe(1);
      } finally { fresh.close(); }
      const resumed = fixture();
      try { await resumed.commands.get("sentinel-bootstrap")!.handler("", resumed.ctx); expect(resumed.counts().newSessions).toBe(0); }
      finally { resumed.close(); }
    } finally { process.argv.splice(0, process.argv.length, ...original); }
  });

  it("rejects symlinked request records and admits a later atomic owned record", async () => {
    const f = fixture();
    try {
      const request = f.request();
      // Replace atomically before watcher callbacks run, so only the committed symlink is inspected.
      const foreign = join(f.root, "foreign.json"); writeFileSync(foreign, readFileSync(join(f.control, "request.json")));
      rmSync(join(f.control, "request.json")); symlinkSync(foreign, join(f.control, "request.json"));
      await Bun.sleep(550); expect(f.messages).toHaveLength(0);
      rmSync(join(f.control, "request.json")); f.write("unrelated.json", {}); f.write("request.json", request);
      await until(() => f.messages.length === 1);
    } finally { f.close(); }
  });
});
