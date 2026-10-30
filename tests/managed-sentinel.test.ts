import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ManagedSentinelBridge } from "../src/extension/managed-sentinel";

// These filesystem integration cases intentionally exercise native fs.watch plus
// the real bounded fallback interval. Fake timers cannot drive OS watcher delivery.
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
  const request = (changes: object = {}) => {
    const binding = metadata();
    const value = { version: 1, launchId, requestId: crypto.randomUUID(), sessionId: binding.sessionId,
      instanceId: binding.instanceId, expiresAt: Date.now() + 30_000, prompt: "Return the review JSON plan.", ...changes };
    write("request.json", value); return value;
  };
  return { root, control, sessions, launchId, ctx, pi, bridge, emit, messages, commands, metadata, response, request, write,
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

  it("rejects symlinked request records and keeps bounded polling when the wakeup is unrelated", async () => {
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
