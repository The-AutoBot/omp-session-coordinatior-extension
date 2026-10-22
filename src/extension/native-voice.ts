import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { VoiceHostCommand, VoiceHostEvent } from "../shared/protocol";

interface HostBinding {
  voiceId: string;
  bindingGeneration: string;
  roomDigest: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  delegationId?: string;
  delegationGeneration: number;
  pendingText?: string;
  observed: boolean;
  finalText?: string;
}
export interface NativeVoiceMessage {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
  stopReason?: string;
}
export interface NativeVoiceAgentEnd {
  willContinue?: boolean;
  messages?: unknown[];
}

export interface NativeHostVoiceOptions {
  pi: ExtensionAPI;
  identity(): { pcId: string; sessionId: string; roomLink: string | null } | null;
  publish(event: VoiceHostEvent): void;
}
const MAX_RESULT_BYTES = 32_768;

/** Private host command handler; events are accepted only from the authenticated local bus connection. */
export class NativeHostVoice {
  private binding: HostBinding | undefined;
  private readonly options: NativeHostVoiceOptions;

  constructor(options: NativeHostVoiceOptions) { this.options = options; }

  private current(): HostBinding | undefined {
    const binding = this.binding;
    const identity = this.options.identity();
    if (!binding || !identity || !identity.roomLink || binding.deadline <= Date.now() ||
        createHash("sha256").update(identity.roomLink).digest("hex") !== binding.roomDigest) {
      if (binding) this.close("room_changed");
      return undefined;
    }
    return binding;
  }

  private publish(binding: HostBinding, event: VoiceHostEvent["event"], extra: Partial<VoiceHostEvent> = {}): void {
    this.options.publish({ type: "voice_event", voiceId: binding.voiceId,
      bindingGeneration: binding.bindingGeneration, event, ...extra });
  }

  handle(command: VoiceHostCommand): void {
    const identity = this.options.identity();
    if (!identity || !identity.roomLink) return;
    if (command.type === "voice_bind") {
      if (this.binding) this.close("closed");
      if (command.pcId !== identity.pcId || command.sessionId !== identity.sessionId ||
          command.deadline <= Date.now() || command.deadline > Date.now() + 45_000 ||
          createHash("sha256").update(identity.roomLink).digest("hex") !== command.roomDigest) return;
      const binding: HostBinding = { voiceId: command.voiceId, bindingGeneration: command.bindingGeneration,
        roomDigest: command.roomDigest, deadline: command.deadline, delegationGeneration: 0,
        observed: false, timer: setTimeout(() => this.close("expired"), command.deadline - Date.now()) };
      this.binding = binding;
      this.publish(binding, "bound");
      return;
    }
    const binding = this.current();
    if (!binding || binding.voiceId !== command.voiceId || binding.bindingGeneration !== command.bindingGeneration) return;
    if (command.type === "voice_close") { this.close("closed"); return; }
    if (command.type === "voice_renew") {
      if (command.deadline <= Date.now() || command.deadline > Date.now() + 45_000) { this.close("expired"); return; }
      clearTimeout(binding.timer);
      binding.deadline = command.deadline;
      binding.timer = setTimeout(() => this.close("expired"), command.deadline - Date.now());
      return;
    }
    if (command.delegationGeneration !== binding.delegationGeneration + 1) return;
    binding.delegationGeneration = command.delegationGeneration;
    binding.delegationId = command.delegationId;
    binding.pendingText = command.text;
    binding.observed = false;
    delete binding.finalText;
    try {
      this.options.pi.sendMessage({ customType: "live-delegation", content: command.text,
        display: true, attribution: "agent",
        details: { voiceId: binding.voiceId, bindingGeneration: binding.bindingGeneration,
          delegationGeneration: binding.delegationGeneration } }, { triggerTurn: true });
    } catch { this.close("delivery_failed"); }
  }

  /** A custom message is not confirmed until OMP actually includes it in its agent run. */
  messageStart(message: NativeVoiceMessage): void {
    const binding = this.current();
    if (!binding || !binding.delegationId) return;
    if (message.role === "custom" && message.customType === "live-delegation" &&
        typeof message.details === "object" && message.details !== null &&
        "voiceId" in message.details && message.details.voiceId === binding.voiceId &&
        "bindingGeneration" in message.details && message.details.bindingGeneration === binding.bindingGeneration &&
        "delegationGeneration" in message.details && message.details.delegationGeneration === binding.delegationGeneration &&
        message.content === binding.pendingText) {
      delete binding.pendingText;
      binding.observed = true;
      this.publish(binding, "observed", { delegationId: binding.delegationId,
        delegationGeneration: binding.delegationGeneration });
    } else if (message.role === "user" || message.role === "custom") {
      // A later foreign input invalidates answer ownership; work may continue but cannot be spoken as this delegation.
      this.close("foreign_turn");
    }
  }

  messageEnd(message: NativeVoiceMessage): void {
    const binding = this.current();
    if (!binding?.observed || message.role !== "assistant" || !Array.isArray(message.content)) return;
    if (message.stopReason === "aborted" || message.stopReason === "error") { this.close("foreign_turn"); return; }
    const text = message.content.filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" &&
      "text" in part && typeof part.text === "string").map(part => part.text).join("").trim();
    if (!text) return;
    if (Buffer.byteLength(text) > MAX_RESULT_BYTES) { this.close("delivery_failed"); return; }
    if (message.stopReason === "toolUse") {
      this.publish(binding, "commentary", { delegationId: binding.delegationId,
        delegationGeneration: binding.delegationGeneration, text });
    } else if (message.stopReason === "stop") binding.finalText = text;
  }

  agentEnd(event: NativeVoiceAgentEnd): void {
    const binding = this.current();
    if (!binding?.observed || event.willContinue) return;
    if (binding.finalText && binding.delegationId) {
      this.publish(binding, "final", { delegationId: binding.delegationId,
        delegationGeneration: binding.delegationGeneration, text: binding.finalText });
      delete binding.delegationId;
      delete binding.finalText;
      binding.observed = false;
    } else this.close("foreign_turn");
  }

  /** OMP has no public steer-removal API: discard revoked queued delegations at the
   * last extension-visible boundary before any provider request sees their text. */
  filterContext<T extends { role: string; customType?: string; details?: unknown }>(messages: T[]): T[] {
    const active = this.current();
    return messages.filter(message => {
      if (message.role !== "custom" || message.customType !== "live-delegation" ||
          typeof message.details !== "object" || message.details === null ||
          !("voiceId" in message.details) || !("bindingGeneration" in message.details) ||
          !("delegationGeneration" in message.details)) return true;
      return active !== undefined && active.voiceId === message.details.voiceId &&
        active.bindingGeneration === message.details.bindingGeneration &&
        active.delegationGeneration === message.details.delegationGeneration;
    });
  }

  close(code: "closed" | "expired" | "room_changed" | "foreign_turn" | "delivery_failed"): void {
    const binding = this.binding;
    if (!binding) return;
    this.binding = undefined;
    clearTimeout(binding.timer);
    this.publish(binding, code === "closed" ? "closed" : "unavailable", { code });
  }
}
