import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SessionConsult } from "../src/extension/session-consult";
import { inspectClientRequestSchema, inspectResultSchema } from "../src/shared/session-consult";

function fixture(entries: unknown[] = [], runEphemeralTurn?: ExtensionContext["runEphemeralTurn"]) {
  let current = true;
  const ctx = { sessionManager: { getSessionId: () => "target", getEntries: () => [...entries] }, runEphemeralTurn } as unknown as ExtensionContext;
  return { consult: new SessionConsult(ctx, () => current), entries, change: () => { current = false; } };
}
const signal = new AbortController().signal;

describe("detached session consultation", () => {
  test("history reconstructs oversized Unicode journal entries and fixes append boundary", async () => {
    const entries = [{ type: "message", branch: "old", text: "🙂\ud800".repeat(22_000) }, { type: "compaction", summary: "retained" }];
    const f = fixture(entries);
    let result = await f.consult.handle({ kind: "history", entryIndex: 0, offset: 0 }, signal);
    const recovered = ["", ""];
    let pages = 0;
    f.entries.push({ type: "toolResult", text: "later" } as never);
    while (result.kind === "history") {
      expect(result.text.length).toBeLessThanOrEqual(32_000);
      expect(result.throughEntryCount).toBe(2);
      recovered[result.entryIndex] += result.text;
      pages++;
      if (!result.next) break;
      result = await f.consult.handle({ kind: "history", ...result.next, throughEntryCount: result.throughEntryCount }, signal);
    }
    expect(pages).toBeGreaterThan(2);
    expect(recovered).toEqual(entries.slice(0, 2).map(entry => JSON.stringify(entry)));
  });

  test("empty journal rejects invalid cursors and changed journal fails closed", async () => {
    const f = fixture();
    expect(await f.consult.handle({ kind: "history", entryIndex: 0, offset: 0 }, signal)).toMatchObject({ text: "", next: null });
    expect(await f.consult.handle({ kind: "history", entryIndex: 0, offset: 1 }, signal)).toEqual({ kind: "error", code: "invalid_cursor" });
    f.entries.push({ id: "first" });
    await f.consult.handle({ kind: "history", entryIndex: 0, offset: 0 }, signal);
    Object.assign(f.entries[0] as object, { id: "replacement" });
    expect(await f.consult.handle({ kind: "history", entryIndex: 0, offset: 0, throughEntryCount: 1 }, signal)).toEqual({ kind: "error", code: "invalid_cursor" });
    f.change();
    expect(await f.consult.handle({ kind: "history", entryIndex: 0, offset: 0 }, signal)).toEqual({ kind: "error", code: "unavailable" });
  });

  test("questions use native tools:false and streaming cap aborts inference", async () => {
    let aborted = false;
    const f = fixture([], async options => {
      expect(options.tools).toBe(false);
      options.signal!.addEventListener("abort", () => { aborted = true; });
      await options.onTextDelta!("x".repeat(256_001));
      throw new Error("unreachable");
    });
    expect(await f.consult.handle({ kind: "question", question: "status?" }, signal)).toEqual({ kind: "error", code: "answer_too_large" });
    expect(aborted).toBe(true);
  });

  test("single flight, cancellation propagation and cleanup permit next question", async () => {
    let calls = 0;
    const { promise: started, resolve: began } = Promise.withResolvers<void>();
    const f = fixture([], async options => {
      calls++;
      if (calls === 1) {
        began();
        const { promise, reject } = Promise.withResolvers<void>();
        options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        await promise;
      }
      return { replyText: "answer" } as never;
    });
    const controller = new AbortController();
    const pending = f.consult.handle({ kind: "question", question: "first" }, controller.signal);
    await started;
    expect(await f.consult.handle({ kind: "question", question: "parallel" }, signal)).toEqual({ kind: "error", code: "unavailable" });
    controller.abort();
    expect(await pending).toEqual({ kind: "error", code: "cancelled" });
    expect(await f.consult.handle({ kind: "question", question: "next" }, signal)).toEqual({ kind: "answer", sessionId: "target", text: "answer" });
  });

  test("missing native API and native no-tools rejection never fall back", async () => {
    expect(await fixture().consult.handle({ kind: "question", question: "?" }, signal)).toEqual({ kind: "error", code: "unsupported_host" });
    const f = fixture([], async () => { throw new Error("transport requires native tools"); });
    expect(await f.consult.handle({ kind: "question", question: "?" }, signal)).toEqual({ kind: "error", code: "question_failed" });
  });

  test("diagnostics distinguish native rejection and malformed result without private text", async () => {
    const diagnostics: Readonly<Record<string, string | number | boolean>>[] = [];
    const privateText = "private question provider error payload";
    const context = (runEphemeralTurn: ExtensionContext["runEphemeralTurn"]) =>
      ({ sessionManager: { getSessionId: () => "target" }, runEphemeralTurn }) as unknown as ExtensionContext;
    for (const run of [
      async () => { throw new TypeError(privateText); },
      async () => ({ replyText: undefined }) as never,
    ]) {
      const consult = new SessionConsult(context(run), () => true, fields => diagnostics.push(fields));
      expect(await consult.handle({ kind: "question", question: privateText }, signal))
        .toEqual({ kind: "error", code: "question_failed" });
    }
    expect(diagnostics[0]).toMatchObject({ stage: "native-call", errorType: "TypeError", reason: "unclassified" });
    expect(diagnostics[1]).toMatchObject({ stage: "result", reason: "invalid-result-shape", replyType: "undefined" });
    expect(diagnostics[0]!.consultationId).not.toBe(diagnostics[1]!.consultationId);
    expect(JSON.stringify(diagnostics)).not.toContain(privateText);
  });

  test("returned stop reason and emptiness are bounded and diagnostic sink failure is inert", async () => {
    const diagnostics: Readonly<Record<string, string | number | boolean>>[] = [];
    const ctx = { sessionManager: { getSessionId: () => "target" }, runEphemeralTurn: async (options: { tools?: boolean; dedupeReply?: boolean }) => {
      expect(options.tools).toBe(false); expect(options.dedupeReply).toBe(false);
      return { replyText: "", assistantMessage: { stopReason: "length" } };
    } } as unknown as ExtensionContext;
    const consult = new SessionConsult(ctx, () => true, fields => { diagnostics.push(fields); throw Error("sink"); });
    expect(await consult.handle({ kind: "question", question: "?" }, signal)).toEqual({ kind: "answer", sessionId: "target", text: "" });
    expect(diagnostics[0]).toMatchObject({ outcome: "answer", stopReason: "length", empty: true });
  });

  test("native error metadata is allowlisted without invoking getters or exposing private payloads", async () => {
    const diagnostics: Readonly<Record<string, string | number | boolean>>[] = [];
    let getterReads = 0;
    const known = Object.assign(new Error("PRIVATE_MESSAGE"), { name: "RateLimitError", status: 429, code: "ECONNRESET", headers: "PRIVATE_HEADERS" });
    const unknown = Object.assign(new Error("PRIVATE_MESSAGE"), { name: "PRIVATE_NAME", code: "PRIVATE_CODE" });
    Object.defineProperty(unknown, "status", { get() { getterReads++; throw Error("PRIVATE_GETTER"); } });
    for (const failure of [known, unknown]) {
      const ctx = { sessionManager: { getSessionId: () => "target" }, runEphemeralTurn: async () => { throw failure; } } as unknown as ExtensionContext;
      const consult = new SessionConsult(ctx, () => true, fields => diagnostics.push(fields));
      expect(await consult.handle({ kind: "question", question: "PRIVATE_QUESTION" }, signal)).toEqual({ kind: "error", code: "question_failed" });
    }
    expect(diagnostics[0]).toMatchObject({ errorType: "RateLimitError", httpStatus: 429, networkCode: "ECONNRESET" });
    expect(diagnostics[1]).toMatchObject({ errorType: "Error" });
    expect(diagnostics[1]).not.toHaveProperty("httpStatus");
    expect(diagnostics[1]).not.toHaveProperty("networkCode");
    expect(getterReads).toBe(0);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
  });

  test("a returned reply after a binding change is logged as unavailable, never as an answer", async () => {
    const diagnostics: Readonly<Record<string, string | number | boolean>>[] = [];
    let current = true;
    const ctx = { sessionManager: { getSessionId: () => "target" }, runEphemeralTurn: async () => {
      current = false;
      return { replyText: "late", assistantMessage: { stopReason: "stop" } };
    } } as unknown as ExtensionContext;
    const consult = new SessionConsult(ctx, () => current, fields => diagnostics.push(fields));
    expect(await consult.handle({ kind: "question", question: "?" }, signal)).toEqual({ kind: "error", code: "unavailable" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ outcome: "unavailable", stopReason: "stop" });
  });

  test("hostile error metadata cannot escape the consultation failure boundary", async () => {
    const diagnostics: Readonly<Record<string, string | number | boolean>>[] = [];
    const failure = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("PRIVATE_DESCRIPTOR"); } });
    const ctx = { sessionManager: { getSessionId: () => "target" }, runEphemeralTurn: async () => { throw failure; } } as unknown as ExtensionContext;
    const consult = new SessionConsult(ctx, () => true, fields => diagnostics.push(fields));
    expect(await consult.handle({ kind: "question", question: "?" }, signal)).toEqual({ kind: "error", code: "question_failed" });
    expect(diagnostics[0]).toMatchObject({ outcome: "question_failed", reason: "diagnostic-fields-unavailable" });
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
  });

  test("wire defaults, strictness and answer bound", () => {
    const request = { type: "session_inspect", requestId: crypto.randomUUID(), to: "target", operation: { kind: "history" } };
    expect(inspectClientRequestSchema.parse(request).operation).toEqual({ kind: "history", entryIndex: 0, offset: 0 });
    expect(inspectClientRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
    expect(inspectResultSchema.safeParse({ kind: "answer", sessionId: "target", text: "x".repeat(256_001) }).success).toBe(false);
  });
  test("consultation rejects obsolete correction operations and receipts", () => {
    const request = {type:"session_inspect",requestId:crypto.randomUUID(),to:"target"};
    for (const delivery of ["followUp", "steer"]) {
      expect(inspectClientRequestSchema.safeParse({...request,operation:{
        kind:"intervene",expectedInstanceId:crypto.randomUUID(),text:"Correction",
        delivery,expiresAt:Date.now()+30_000,source:"sentinel",
      }}).success).toBe(false);
    }
    expect(inspectResultSchema.safeParse({kind:"intervention",sessionId:"target",delivered:true}).success).toBe(false);
    expect(inspectClientRequestSchema.safeParse({...request,operation:{kind:"snapshot"}}).success).toBe(false);
  });
});
