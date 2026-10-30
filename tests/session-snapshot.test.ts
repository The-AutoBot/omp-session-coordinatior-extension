import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SessionConsult } from "../src/extension/session-consult";
import { inspectOperationSchema, inspectResultSchema, type InspectResult } from "../src/shared/session-consult";

const signal = new AbortController().signal;
function fixture() {
  const entries = [{ id: "root", type: "message", text: "🙂\ud800".repeat(24_000) }, { id: "compact", type: "compaction", summary: "retained" }];
  let branch = entries.map(entry => ({ ...entry }));
  const instructions = ["system instructions", "project instructions"];
  let current = true;
  const delivered: { text: string; delivery: string }[] = [];
  const ctx = { sessionManager: { getSessionId: () => "target", getEntries: () => entries, getBranch: () => branch, getLeafId: () => branch.at(-1)?.id ?? null }, getSystemPrompt: () => instructions } as unknown as ExtensionContext;
  const consult = new SessionConsult(ctx, () => current, { allowSteer: false, deliver: (text, delivery) => delivered.push({text, delivery}) });
  return { consult, entries, instructions, delivered, ctx, switch: () => {current = false;}, branch: () => {branch = branch.slice(0,1);} };
}
function snapshot(result: InspectResult) {
  if (result.kind !== "snapshot") throw new Error(JSON.stringify(result));
  expect(inspectResultSchema.safeParse(result).success).toBe(true);
  return result;
}

test("snapshot reconstructs each public section once, with explicit unavailable effective context", async () => {
  const f = fixture();
  let page = snapshot(await f.consult.handle({kind:"snapshot"}, signal));
  const parts: string[] = [];
  const revision = page.revision;
  while (true) {
    expect(page.text.length).toBeLessThanOrEqual(32_000);
    expect(page.revision).toBe(revision);
    parts[page.part] = (parts[page.part] ?? "") + page.text;
    if (!page.next) break;
    page = snapshot(await f.consult.handle({kind:"snapshot",cursor:page.next}, signal));
  }
  const manifest = JSON.parse(parts[0]!);
  expect(manifest.completeness.effectiveModelContext).toBe("unavailable");
  expect(manifest.completeness.providerHookChanges).toBe("unavailable");
  expect(manifest.markers.compactions).toBe(1);
  expect(parts.slice(1,3).map(text => JSON.parse(text))).toEqual(f.entries);
  expect(parts.slice(3,5).map(text => JSON.parse(text))).toEqual(["root","compact"]);
  expect(parts.slice(5).map(text => JSON.parse(text))).toEqual(f.instructions);
});

test("journal append/edit, branch and instruction changes reject intervention against captured context", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.entries.push({id:"later",type:"message",text:"new"}), (f: ReturnType<typeof fixture>) => { f.entries[0]!.text = "edited"; }, (f: ReturnType<typeof fixture>) => f.branch(), (f: ReturnType<typeof fixture>) => f.instructions.push("new instruction")]) {
    const f = fixture();
    const first = snapshot(await f.consult.handle({kind:"snapshot"},signal));
    mutate(f);
    expect(await f.consult.handle({kind:"intervene",snapshotId:first.snapshotId,expectedInstanceId:first.instanceId,revision:first.revision,text:"Review",delivery:"followUp",expiresAt:Date.now()+60_000,source:"sentinel"},signal)).toEqual({kind:"error",code:"invalid_cursor"});
  }
});

test("snapshot leases cannot cross instances, explicit invalidation, replacement, switch or expiry", async () => {
  const f = fixture();
  const first = snapshot(await f.consult.handle({kind:"snapshot"},signal));
  const other = new SessionConsult(f.ctx, () => true);
  expect(await other.handle({kind:"snapshot",cursor:first.next!},signal)).toEqual({kind:"error",code:"invalid_cursor"});
  await f.consult.handle({kind:"snapshot"},signal);
  expect(await f.consult.handle({kind:"snapshot",cursor:first.next!},signal)).toEqual({kind:"error",code:"invalid_cursor"});
  const fresh = snapshot(await f.consult.handle({kind:"snapshot"},signal));
  f.consult.invalidate();
  expect(await f.consult.handle({kind:"snapshot",cursor:fresh.next!},signal)).toEqual({kind:"error",code:"invalid_cursor"});
  const leased = snapshot(await f.consult.handle({kind:"snapshot"},signal));
  const now = Date.now;
  try {
    Date.now = () => now() + 600_001;
    expect(await f.consult.handle({kind:"snapshot",cursor:leased.next!},signal)).toEqual({kind:"error",code:"invalid_cursor"});
  } finally { Date.now = now; }
  f.switch();
  expect(await f.consult.handle({kind:"snapshot"},signal)).toEqual({kind:"error",code:"unavailable"});
});

test("targeted intervention requires fresh binding, respects steering opt-in and attributes delivery only", async () => {
  const f = fixture();
  const first = snapshot(await f.consult.handle({kind:"snapshot"},signal));
  const request = {kind:"intervene" as const,snapshotId:first.snapshotId,expectedInstanceId:first.instanceId,revision:first.revision,text:"Review the unverified path",delivery:"followUp" as const,expiresAt:Date.now()+60_000,source:"sentinel" as const};
  expect(await f.consult.handle({...request,delivery:"steer"},signal)).toEqual({kind:"error",code:"steering_disabled"});
  expect(await f.consult.handle({...request,expiresAt:1},signal)).toEqual({kind:"error",code:"expired"});
  expect(await f.consult.handle({...request,expectedInstanceId:crypto.randomUUID()},signal)).toEqual({kind:"error",code:"invalid_cursor"});
  expect(f.delivered).toHaveLength(0);
  expect(await f.consult.handle(request,signal)).toEqual({kind:"intervention",sessionId:"target",delivered:true});
  expect(f.delivered[0]!.text).toContain("not user authorization");
  expect(f.delivered[0]!.delivery).toBe("followUp");
  expect(await f.consult.handle(request,signal)).toEqual({kind:"error",code:"invalid_cursor"});
  expect(f.delivered).toHaveLength(1);
});

test("unsupported hosts, cancellation and strict bounded cursors fail closed", async () => {
  const ctx = {sessionManager:{getSessionId:()=>"target"}} as unknown as ExtensionContext;
  expect(await new SessionConsult(ctx,()=>true).handle({kind:"snapshot"},signal)).toEqual({kind:"error",code:"unsupported_host"});
  const f = fixture(); const abort = new AbortController(); abort.abort();
  expect(await f.consult.handle({kind:"snapshot"},abort.signal)).toEqual({kind:"error",code:"cancelled"});
  expect(inspectOperationSchema.safeParse({kind:"snapshot",cursor:{snapshotId:crypto.randomUUID(),revision:"a".repeat(64),part:-1,offset:0}}).success).toBe(false);
  expect(inspectOperationSchema.safeParse({kind:"snapshot",extra:true}).success).toBe(false);
});

test("registered instance and immutable goal prefix permit busy assistant/tool append, not new user input", async () => {
  const instanceId = crypto.randomUUID();
  const entries = [{id:"user",type:"message",message:{role:"user",content:"original goal"}}];
  const delivered: string[] = [];
  const ctx = { sessionManager: {
    getSessionId: () => "busy", getEntries: () => entries, getBranch: () => entries,
    getLeafId: () => entries.at(-1)!.id,
  }, getSystemPrompt: () => ["fixed instructions"] } as unknown as ExtensionContext;
  const consult = new SessionConsult(ctx, () => true, {allowSteer:false,deliver:text=>{delivered.push(text);}}, instanceId);
  const first = snapshot(await consult.handle({kind:"snapshot"},signal));
  expect(first.instanceId).toBe(instanceId);
  entries.push({id:"assistant",type:"message",message:{role:"assistant",content:"ongoing work"}});
  entries.push({id:"tool",type:"message",message:{role:"toolResult",content:"tool observation"}});
  const continued = snapshot(await consult.handle({kind:"snapshot",cursor:first.next!},signal));
  expect(continued.revision).toBe(first.revision);
  const request = {kind:"intervene" as const,snapshotId:first.snapshotId,expectedInstanceId:instanceId,revision:first.revision,text:"Recheck goal alignment",delivery:"followUp" as const,expiresAt:Date.now()+60_000,source:"sentinel" as const};
  expect(await consult.handle(request,signal)).toMatchObject({kind:"intervention",delivered:true});
  const second = snapshot(await consult.handle({kind:"snapshot"},signal));
  entries.push({id:"new-user",type:"message",message:{role:"user",content:"new scope instruction"}});
  expect(await consult.handle({...request,snapshotId:second.snapshotId,revision:second.revision},signal)).toEqual({kind:"error",code:"invalid_cursor"});
  expect(delivered).toHaveLength(1);
});

test("frozen pages never leak prefix edits, and final-page validation rejects stale captures", async () => {
  const f = fixture();
  const first = snapshot(await f.consult.handle({kind:"snapshot"},signal));
  const original = JSON.stringify(f.entries[0]);
  f.entries[0]!.text = "replacement must not leak";
  let page = snapshot(await f.consult.handle({kind:"snapshot",cursor:first.next!},signal));
  let recovered = page.text;
  while (page.next?.part === 1) {
    page = snapshot(await f.consult.handle({kind:"snapshot",cursor:page.next},signal));
    recovered += page.text;
  }
  expect(recovered).toBe(original);
  let result: InspectResult = page;
  while (result.kind === "snapshot" && result.next) result = await f.consult.handle({kind:"snapshot",cursor:result.next},signal);
  expect(result).toEqual({kind:"error",code:"invalid_cursor"});
});

test("snapshot resource exhaustion rejects the complete export, never clips", async () => {
  const entries = Array(200_000).fill({id:"entry",type:"message"});
  const ctx = {sessionManager:{getSessionId:()=>"large",getLeafId:()=>null,getEntries:()=>entries,getBranch:()=>[]},getSystemPrompt:()=>[]} as unknown as ExtensionContext;
  expect(await new SessionConsult(ctx,()=>true).handle({kind:"snapshot"},signal)).toEqual({kind:"error",code:"snapshot_too_large"});
});

test("thousands of entries page in linear-ish consumer time without history reserialization per fragment", async () => {
  async function consume(count: number) {
    const entries = Array.from({length:count},(_,i)=>({id:String(i),type:"message",text:"x".repeat(12_000)}));
    const ctx = {sessionManager:{getSessionId:()=>"large",getLeafId:()=>String(count-1),getEntries:()=>entries,getBranch:()=>entries},getSystemPrompt:()=>["instructions"]} as unknown as ExtensionContext;
    const consult = new SessionConsult(ctx,()=>true);
    const start = performance.now();
    let result = await consult.handle({kind:"snapshot"},signal);
    let pages = 0, characters = 0;
    while (result.kind === "snapshot") {
      pages++; characters += result.text.length;
      if (!result.next) break;
      result = await consult.handle({kind:"snapshot",cursor:result.next},signal);
    }
    expect(result.kind).toBe("snapshot");
    expect(pages).toBe(2*count+2);
    expect(characters).toBeGreaterThan(count*12_000);
    return performance.now()-start;
  }
  const small = await consume(1000);
  const large = await consume(4000);
  console.log(JSON.stringify({snapshotPagingMilliseconds:{entries1000:small,entries4000:large}}));
  expect(large).toBeLessThan(small*8+500);
  expect(large).toBeLessThan(15_000);
},30_000);
