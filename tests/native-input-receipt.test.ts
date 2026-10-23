import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { fingerprintInput, type InputReceiptContent, type InputReceiptRequest } from "../src/shared/collab-input-receipts";
import { discoverLocalCollabRoom } from "../src/extension/collab-registry";
import { NativeInputReceipt, type NativeInputReceiptBinding } from "../src/extension/native-input-receipt";

const roomLink = `https://collab.example.test/#fixture.${"s".repeat(43)}`;
const roomGeneration = createHash("sha256").update(roomLink).digest("hex");
const originalText = `${"prefix".repeat(130_000)}\n尾🙂\\\"\ud800 original tail`;
const firstImage = { type: "image" as const, mimeType: "image/png", data: `${"QUFB".repeat(180_000)}QUI=` };
const original: InputReceiptContent[] = [
  { type: "text", text: originalText },
  firstImage,
  { type: "image", mimeType: "image/jpeg", data: "Q0NE" },
];

function fixture(content: InputReceiptContent[] = original) {
  let entry: unknown = { id: "entry-one", type: "custom_message", customType: "collab-prompt", content, details: { from: "Guest" } };
  let managerSession = "session-one";
  // Deliberately partial public-manager double; entry shapes vary to test malformed persisted data.
  const manager = { getEntry: () => entry, getSessionId: () => managerSession } as unknown as ExtensionContext["sessionManager"];
  let binding: NativeInputReceiptBinding | null = { pcId: "fixture-pc", sessionId: managerSession, roomLink, generation: 1, sessionManager: manager };
  let hosts: unknown[] = [{ instanceId: "host-one", generation: 1, inputRequired: false,
    sessionId: managerSession, pid: process.pid, relayConnected: true, access: "control" }];
  const discover = () => discoverLocalCollabRoom("session-one", process.pid, async args => args[0] === "list"
    ? { version: 1, hosts } : { version: 1, instanceId: "host-one", generation: 1, access: "control", url: roomLink });
  const options = { binding: () => binding, discover };
  const service = new NativeInputReceipt(options);
  return { service, options, discover,
    setEntry: (value: unknown) => { entry = value; },
    setHosts: (value: unknown[]) => { hosts = value; },
    currentHosts: () => hosts,
    reassign: () => { binding = { ...binding!, generation: binding!.generation + 1 }; },
    disconnect: () => { binding = null; },
    switchSession: () => { managerSession = "another-session"; },
  };
}
async function request(content = original): Promise<InputReceiptRequest> {
  return { version: 1, pcId: "fixture-pc", sessionId: "session-one", roomGeneration,
    entryId: "entry-one", senderName: "Guest", contentDigest: await fingerprintInput(content) };
}

describe("native original input receipts", () => {
  it("advertises receipts only for the exact freshly verified local CONTROL room", async () => {
    const f = fixture();
    expect(await f.service.verifyRoom(roomLink)).toBe(true);
    expect(await f.service.verifyRoom(`https://collab.example.test/#external.${"t".repeat(43)}`)).toBe(false);
    const host = f.currentHosts()[0] as Record<string, unknown>;
    for (const hosts of [[], [host, host], [{ ...host, relayConnected: false }], [{ ...host, access: "view" }]]) {
      f.setHosts(hosts);
      expect(await f.service.verifyRoom(roomLink)).toBe(false);
    }
  });

  it("does not advertise a room after binding reassignment during registry verification", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const service = new NativeInputReceipt({ ...f.options, discover: async () => {
      entered.resolve();
      await gate.promise;
      return f.discover();
    } });
    const pending = service.verifyRoom(roomLink);
    await entered.promise;
    f.reassign();
    gate.resolve();
    expect(await pending).toBe(false);
  });

  it("matches full persisted text and original image bytes, including Unicode and escaping", async () => {
    const f = fixture();
    expect(await f.service.handle(await request())).toEqual({ version: 1, status: "matched" });
  });

  it("rejects tails sharing the same clipped prefix, image order/count/MIME and Unicode changes", async () => {
    const f = fixture();
    const variants: InputReceiptContent[][] = [
      [{ type: "text", text: originalText + "changed" }, ...original.slice(1)],
      [original[0]!, { ...firstImage, data: `${"QUFB".repeat(180_000)}QUM=` }, original[2]!],
      [original[0]!, original[2]!, original[1]!], original.slice(0, 2),
      [original[0]!, { ...firstImage, mimeType: "image/webp" }, original[2]!],
      [{ type: "text", text: originalText.replace("尾🙂", "尾🙃") }, ...original.slice(1)],
    ];
    for (const content of variants) expect((await f.service.handle(await request(content))).status).toBe("mismatch");
  });

  it("fails closed for wrong entry type, custom type, sender, ID, absence and malformed content", async () => {
    const f = fixture();
    const r = await request();
    for (const change of [{ type: "message" }, { customType: "other" }, { details: { from: "Other" } },
      { id: "another" }, { content: [{ type: "audio", data: "bad" }] }]) {
      f.setEntry({ id: "entry-one", type: "custom_message", customType: "collab-prompt", content: original, details: { from: "Guest" }, ...change });
      expect((await f.service.handle(r)).status).not.toBe("matched");
    }
    f.setEntry(undefined);
    expect((await f.service.handle(r)).status).toBe("unavailable");
  });

  it("rejects wrong PC/session/capability generation and mutated public manager session", async () => {
    const f = fixture();
    const r = await request();
    for (const change of [{ pcId: "other-pc" }, { sessionId: "other-session" }, { roomGeneration: "a".repeat(64) }]) {
      expect((await f.service.handle({ ...r, ...change })).status).toBe("unavailable");
    }
    f.switchSession();
    expect((await f.service.handle(r)).status).toBe("unavailable");
  });

  it("rejects absent, ambiguous, disconnected and non-control registry hosts", async () => {
    const f = fixture();
    const host = f.currentHosts()[0] as Record<string, unknown>;
    const r = await request();
    for (const hosts of [[], [host, host], [{ ...host, relayConnected: false }], [{ ...host, access: "view" }]]) {
      f.setHosts(hosts);
      expect((await f.service.handle(r)).status).toBe("unavailable");
    }
  });

  it("revalidates bindings across both async registry boundaries, including same-room reassignment", async () => {
    for (const boundary of [1, 2]) {
      const f = fixture();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let calls = 0;
      const service = new NativeInputReceipt({ ...f.options, discover: async () => {
        if (++calls === boundary) { entered.resolve(); await gate.promise; }
        return f.discover();
      } });
      const pending = service.handle(await request());
      await entered.promise;
      f.reassign();
      gate.resolve();
      expect((await pending).status).toBe("unavailable");
    }
  });

  it("rejects post-hash host generation rotation and disconnection", async () => {
    for (const disconnect of [false, true]) {
      const f = fixture();
      let calls = 0;
      const service = new NativeInputReceipt({ ...f.options, discover: async () => {
        const room = await f.discover();
        if (++calls === 2 && room) {
          if (disconnect) f.disconnect();
          else return { ...room, host: { ...room.host, generation: room.host.generation + 1 } };
        }
        return room;
      } });
      expect((await service.handle(await request())).status).toBe("unavailable");
    }
  });

  it("binds managed publication to the exact captured native URL, never a same-hash alias", async () => {
    const f = fixture();
    const managed = `https://agent.example.test/live/${new URL(roomLink).hash}`;
    let current = { ...f.options.binding()!, roomLink: managed, nativeRoomLink: roomLink };
    const service = new NativeInputReceipt({ ...f.options, binding: () => current });
    const r = { ...await request(), roomGeneration: createHash("sha256").update(managed).digest("hex") };
    expect(await service.verifyRoom(managed)).toBe(true);
    expect((await service.handle(r)).status).toBe("matched");
    current = { ...current, nativeRoomLink: `https://other.example.test/${new URL(roomLink).hash}` };
    expect(await service.verifyRoom(managed)).toBe(false);
    expect((await service.handle(r)).status).toBe("unavailable");
    const manual = new NativeInputReceipt({ ...f.options, binding: () => ({ ...f.options.binding()!, roomLink: managed }) });
    expect(await manual.verifyRoom(managed)).toBe(false);
    expect((await manual.handle(r)).status).toBe("unavailable");
  });

  it("rejects native-alias reassignment across asynchronous verification without relying on a generation bump", async () => {
    const f = fixture();
    const managed = `https://agent.example.test/live/${new URL(roomLink).hash}`;
    let current = { ...f.options.binding()!, roomLink: managed, nativeRoomLink: roomLink };
    const service = new NativeInputReceipt({ binding: () => current, discover: async () => {
      current = { ...current, nativeRoomLink: `https://other.example.test/${new URL(roomLink).hash}` };
      return f.discover();
    } });
    expect(await service.verifyRoom(managed)).toBe(false);
  });

  it("reports unavailable if the public getEntry API is absent or throws", async () => {
    const f = fixture();
    const binding = f.options.binding()!;
    for (const getEntry of [undefined, () => { throw new Error("storage unavailable"); }]) {
      // Deliberately models an older/malformed public manager with an absent or failing API.
      const sessionManager = { getSessionId: () => "session-one", getEntry } as unknown as ExtensionContext["sessionManager"];
      const service = new NativeInputReceipt({ ...f.options, binding: () => ({ ...binding, sessionManager }) });
      expect((await service.handle(await request())).status).toBe("unavailable");
    }
  });
});
