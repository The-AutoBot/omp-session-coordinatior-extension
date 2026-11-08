import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import type { SentinelCorrectionRequest, SentinelCorrectionStatus } from '../shared/sentinel-correction';

type Entry = { request: SentinelCorrectionRequest; status?: SentinelCorrectionStatus; receipt?: SentinelCorrectionStatus; timer?: Timer };
/** Only this live binding can authorize its custom messages; persisted/replayed entries fail closed. */
export class SentinelCorrection {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly pi: ExtensionAPI, private readonly current: () => boolean,
    private readonly sessionId: string, private readonly instanceId: string,
    private readonly report: (requestId: string, status: SentinelCorrectionStatus) => void) {}

  request(request: SentinelCorrectionRequest): void {
    const duplicate = this.entries.get(request.requestId);
    if (duplicate) { if (duplicate.receipt) this.report(request.requestId, duplicate.receipt); return; }
    // Keep terminal entries until rebinding too: an id must never acquire new authority.
    if (this.entries.size >= 256) { this.report(request.requestId, 'unavailable'); return; }
    const entry: Entry = { request };
    this.entries.set(request.requestId, entry);
    if (!this.current() || request.sessionId !== this.sessionId || request.instanceId !== this.instanceId) {
      this.finish(entry, 'unavailable'); return;
    }
    if (request.expiresAt <= Date.now()) { this.finish(entry, 'expired'); return; }
    entry.timer = setTimeout(() => this.finish(entry, 'expired'), Math.min(2_147_483_647, request.expiresAt - Date.now()));
    try {
      this.pi.sendMessage({ customType: 'sentinel:correction', content: request.text, display: true,
        details: { requestId: request.requestId, instanceId: this.instanceId, sessionId: this.sessionId } }, { deliverAs: 'steer' });
    } catch { this.finish(entry, 'unavailable'); }
  }
  cancel(requestId: string): void { const entry = this.entries.get(requestId); if (entry) this.finish(entry, 'cancelled'); }
  cancelPending(): void { for (const entry of this.entries.values()) if (!entry.status) this.finish(entry, 'cancelled'); }
  close(): void { for (const entry of this.entries.values()) { this.finish(entry, 'unavailable'); clearTimeout(entry.timer); } }
  filter<T>(messages: T[]): T[] {
    return messages.filter(message => {
      if (!message || typeof message !== 'object' || !('customType' in message) || message.customType !== 'sentinel:correction') return true;
      if (!('details' in message) || !message.details || typeof message.details !== 'object' || !('requestId' in message.details)) return false;
      const id = message.details.requestId;
      const entry = typeof id === 'string' ? this.entries.get(id) : undefined;
      if (!entry) return false;
      if (!this.current()) { this.finish(entry, 'unavailable'); return false; }
      if (entry.request.expiresAt <= Date.now()) { this.finish(entry, 'expired'); return false; }
      if (entry.status && entry.status !== 'context_admitted') return false;
      if (!('sessionId' in message.details) || message.details.sessionId !== this.sessionId ||
        !('instanceId' in message.details) || message.details.instanceId !== this.instanceId ||
        !('content' in message) || message.content !== entry.request.text) return false;
      this.finish(entry, 'context_admitted');
      return true;
    });
  }
  private finish(entry: Entry, status: SentinelCorrectionStatus): void {
    // Admission receipt is immutable, but cancellation still revokes subsequent context inclusion.
    const previous = entry.status;
    if (previous && previous !== 'context_admitted') return;
    entry.status = status;
    if (status !== 'context_admitted') clearTimeout(entry.timer);
    if (!previous) { entry.receipt = status; this.report(entry.request.requestId, status); }
  }
}
