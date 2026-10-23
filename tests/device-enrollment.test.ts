import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardUrl, enrollDevice, explicitCredentials, persistCredentials, readCredentials, selectStoredCredentials, validateCredentials } from "../src/extension/device-enrollment";

const key = "test-machine-secret-".repeat(3);
describe("device enrollment boundaries", () => {
 it("requires TLS except exact loopback and rejects credential-bearing origins", () => {
  for (const input of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?x=y", "http://127.0.0.2"]) expect(() => dashboardUrl(input)).toThrow();
  for (const input of ["https://example.com", "http://127.0.0.1:3456", "http://[::1]:3456"]) expect(dashboardUrl(input).pathname).toBe("/");
 });
 it("treats even partial explicit environment as authoritative", () => {
  expect(explicitCredentials({})).toBe(false);
  expect(explicitCredentials({OMP_SESSION_BUS_ENDPOINT:""})).toBe(true);
  expect(explicitCredentials({OMP_SESSION_BUS_MACHINE_KEY:key})).toBe(true);
 });
 it("rejects cross-origin credentials and invalid machine identities", () => {
  for (const update of [{busEndpoint:"wss://other.example/bus"}, {busEndpoint:"ws://example.com/bus"}, {pcId:"Other PC"}, {machineKey:"short"}]) expect(() => validateCredentials({dashboard:"https://example.com/",pcId:"pc-test",machineKey:key,busEndpoint:"wss://example.com/bus",...update})).toThrow();
 });
 it("accepts the exact IPv6 loopback credential target", () => {
  expect(validateCredentials({dashboard:"http://[::1]:3456/",pcId:"pc-ipv6",machineKey:key,busEndpoint:"ws://[::1]:3456/bus"}).pcId).toBe("pc-ipv6");
 });
 for (const phase of ["start", "poll"]) {
  for (const malformed of [false, true]) {
   it(`rejects ${malformed ? "malformed JSON" : "oversized streamed JSON"} during ${phase}`, async () => {
    const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:request => {
     const url=new URL(request.url);
     if(phase === "poll" && url.pathname.endsWith("/start")) return Response.json({deviceCode:"d".repeat(48),userCode:"ABCD-EFGH",verificationUri:`${url.origin}/?pair=ABCD-EFGH`,expiresIn:10,interval:1});
     if(malformed) return new Response("{invalid");
     return new Response(new ReadableStream<Uint8Array>({
      start(controller) { for(let i=0;i<8;i++) controller.enqueue(new TextEncoder().encode("x".repeat(4096))); controller.close(); },
     }),{headers:{"content-type":"application/json"}});
    }});
    try {
     await expect(enrollDevice(dashboardUrl(server.url.origin),new AbortController().signal,()=>{})).rejects.toThrow();
    } finally { await server.stop(true); }
   });
  }
 }
 it("keeps explicit credentials until deliberate durable stored-mode selection", () => {
  const saved = {dashboard:"https://example.com/",pcId:"pc-old",machineKey:key,busEndpoint:"wss://example.com/bus"};
  const env = {OMP_SESSION_BUS_MACHINE_KEY:"legacy"};
  expect(selectStoredCredentials(saved,env)).toBeUndefined();
  expect(selectStoredCredentials(saved,{})).toEqual(saved);
  expect(selectStoredCredentials({...saved,preferStored:true},env)?.pcId).toBe("pc-old");
  expect(env.OMP_SESSION_BUS_MACHINE_KEY).toBe("legacy");
 });
 it("durably replaces only valid credentials and preserves existing bytes on failed replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-enrollment-"));
  const path = join(root, "private", "device.json");
  try {
   const old = {dashboard:"https://example.com/",pcId:"pc-old",machineKey:key,busEndpoint:"wss://example.com/bus"};
   persistCredentials(old,path);
   const bytes = readFileSync(path,"utf8");
   expect(() => persistCredentials({...old,machineKey:"invalid"},path)).toThrow();
   expect(readFileSync(path,"utf8")).toBe(bytes);
   persistCredentials({...old,pcId:"pc-new",preferStored:true},path);
   expect(readCredentials(path)).toMatchObject({pcId:"pc-new",preferStored:true});
   if(process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { rmSync(root,{recursive:true,force:true}); }
 });
 it("polls a real HTTP consumer, retries throttling, and accepts only the validated target", async () => {
  let polls = 0;
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch: async request => {
   const url = new URL(request.url);
   if(url.pathname.endsWith("/start")) return Response.json({deviceCode:"d".repeat(48),userCode:"ABCD-EFGH",verificationUri:`${url.origin}/?pair=ABCD-EFGH`,expiresIn:30,interval:1});
   expect(await request.json()).toEqual({deviceCode:"d".repeat(48)});
   if(++polls === 1) return Response.json({error:"slow_down"},{status:429});
   return Response.json({status:"approved",pcId:"pc-new",machineKey:key,busEndpoint:`ws://${url.host}/bus`});
  }});
  try {
   const result = await enrollDevice(dashboardUrl(server.url.origin),new AbortController().signal,(_url,code) => expect(code).toBe("ABCD-EFGH"));
   expect(result.pcId).toBe("pc-new"); expect(polls).toBe(2);
  } finally { await server.stop(true); }
 },15_000);
 it("cancels before polling and supports a fresh retry without retaining device secrets", async () => {
  let starts=0; let polls=0;
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch: request => {
   const url=new URL(request.url);
   if(url.pathname.endsWith("/start")) { starts++; return Response.json({deviceCode:"d".repeat(48),userCode:"ABCD-EFGH",verificationUri:`${url.origin}/?pair=ABCD-EFGH`,expiresIn:10,interval:1}); }
   polls++; return Response.json({status:"denied"});
  }});
  try {
   const controller=new AbortController();
   await expect(enrollDevice(dashboardUrl(server.url.origin),controller.signal,() => controller.abort())).rejects.toThrow();
   expect(polls).toBe(0);
   await expect(enrollDevice(dashboardUrl(server.url.origin),new AbortController().signal,() => {})).rejects.toThrow("denied");
   expect(starts).toBe(2); expect(polls).toBe(1);
  } finally { await server.stop(true); }
 });
});
