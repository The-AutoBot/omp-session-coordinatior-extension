import { createHash } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { fingerprintInputSegments, inputReceiptRequestSchema, type InputReceiptRequest, type InputReceiptResult } from "../shared/collab-input-receipts";
import { discoverLocalCollabRoom, type RegistryRoom } from "./collab-registry";

export interface NativeInputReceiptBinding {
  pcId: string;
  sessionId: string;
  roomLink: string;
  generation: number;
  sessionManager: ExtensionContext["sessionManager"];
}

export interface NativeInputReceiptOptions {
  binding(): NativeInputReceiptBinding | null;
  discover?(sessionId: string, pid: number): Promise<RegistryRoom | null>;
}

/** Read-only proof of the original persisted input, never a proof from a clipped relay echo. */
export class NativeInputReceipt {
  constructor(private readonly options: NativeInputReceiptOptions) {}

  async verifyRoom(roomLink: string): Promise<boolean> {
    const binding = this.options.binding();
    if (!binding || binding.roomLink !== roomLink ||
        binding.sessionManager.getSessionId() !== binding.sessionId) return false;
    try {
      const room = await (this.options.discover ?? discoverLocalCollabRoom)(binding.sessionId, process.pid);
      const current = this.options.binding();
      return current !== null && current.pcId === binding.pcId && current.sessionId === binding.sessionId &&
        current.roomLink === roomLink && current.generation === binding.generation &&
        current.sessionManager === binding.sessionManager &&
        typeof current.sessionManager.getEntry === "function" &&
        current.sessionManager.getSessionId() === binding.sessionId && this.validHost(room, binding);
    } catch {
      return false;
    }
  }

  async handle(request: InputReceiptRequest): Promise<InputReceiptResult> {
    const result = (status: InputReceiptResult["status"]): InputReceiptResult => ({ version: 1, status });
    if (!inputReceiptRequestSchema.safeParse(request).success) return result("unavailable");
    const binding = this.options.binding();
    if (!binding || !this.sameBinding(binding, request)) return result("unavailable");
    const discover = this.options.discover ?? discoverLocalCollabRoom;
    try {
      const before = await discover(binding.sessionId, process.pid);
      if (!this.sameBinding(binding, request) || !this.validHost(before, binding)) return result("unavailable");
      const entry = binding.sessionManager.getEntry(request.entryId);
      if (!entry) return result("unavailable");
      if (entry.id !== request.entryId || entry.type !== "custom_message" || entry.customType !== "collab-prompt" ||
          typeof entry.details !== "object" || entry.details === null ||
          !("from" in entry.details) || entry.details.from !== request.senderName) return result("mismatch");
      const content = typeof entry.content === "string" ? [{ type: "text" as const, text: entry.content }] : entry.content;
      const hash = new Bun.CryptoHasher("sha256");
      for (const segment of fingerprintInputSegments(content)) hash.update(segment);
      const digest = hash.digest("hex");
      const after = await discover(binding.sessionId, process.pid);
      if (!this.sameBinding(binding, request) || !this.validHost(after, binding) ||
          before!.host.instanceId !== after!.host.instanceId || before!.host.generation !== after!.host.generation) {
        return result("unavailable");
      }
      return result(digest === request.contentDigest ? "matched" : "mismatch");
    } catch {
      // Registry, decoder/storage, and resource errors cannot become acknowledgements.
      return result("unavailable");
    }
  }

  private sameBinding(captured: NativeInputReceiptBinding, request: InputReceiptRequest): boolean {
    const current = this.options.binding();
    return current !== null && current.pcId === captured.pcId && current.sessionId === captured.sessionId &&
      current.roomLink === captured.roomLink && current.generation === captured.generation &&
      current.sessionManager === captured.sessionManager && request.pcId === current.pcId &&
      request.sessionId === current.sessionId && typeof current.sessionManager.getEntry === "function" &&
      current.sessionManager.getSessionId() === current.sessionId &&
      createHash("sha256").update(current.roomLink).digest("hex") === request.roomGeneration;
  }

  private validHost(room: RegistryRoom | null, binding: NativeInputReceiptBinding): boolean {
    return room !== null && room.url === binding.roomLink && room.host.sessionId === binding.sessionId &&
      room.host.connected && room.host.access === "control";
  }
}
