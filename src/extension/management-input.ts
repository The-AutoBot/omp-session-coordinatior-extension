import { createHash } from 'node:crypto';

const MAX_IDENTITIES = 4096;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** One native instance's counter. Identities never confer authority or retain prompt text. */
export class ManagementInput {
  private readonly identities = new Set<string>();
  private value = 0;
  private bounded = true;
  constructor(private readonly changed: () => void) {}
  get revision() { return this.value; }
  get available() { return this.bounded; }

  reset(entries: readonly unknown[]): void {
    this.identities.clear(); this.value = 0; this.bounded = true;
    for (const entry of entries) {
      const key = this.identity(entry);
      if (!key || this.identities.has(key)) continue;
      if (this.identities.size >= MAX_IDENTITIES) { this.bounded = false; break; }
      this.identities.add(key);
    }
  }
  advance(): void { this.value += 1; this.changed(); }
  observe(messages: readonly unknown[]): boolean {
    let changed = false;
    for (const message of messages) {
      const key = this.identity(message);
      if (!key || this.identities.has(key) || !this.bounded) continue;
      if (this.identities.size >= MAX_IDENTITIES) this.bounded = false;
      else this.identities.add(key);
      this.advance(); changed = true;
    }
    return changed;
  }
  private identity(message: unknown): string | undefined {
    if (!record(message) || message.customType !== 'collab-prompt' || message.attribution !== 'user' ||
      (message.role !== 'custom' && message.type !== 'custom_message')) return;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
    if (!Number.isSafeInteger(timestamp) || !('content' in message)) return;
    return createHash('sha256').update(JSON.stringify([timestamp, message.content])).digest('hex');
  }
}
