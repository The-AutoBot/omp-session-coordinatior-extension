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
      expect(options.promptText).toContain("untrusted external data");
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
