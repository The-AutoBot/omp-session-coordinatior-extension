import { z } from "zod";

export const INPUT_RECEIPT_MAX_BODY_BYTES = 4_096;
export const inputReceiptRequestSchema = z.object({
  version: z.literal(1),
  pcId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  sessionId: z.string().min(1).max(200).refine(value => value !== "*"),
  roomGeneration: z.string().regex(/^[a-f0-9]{64}$/),
  entryId: z.string().min(1).max(200),
  senderName: z.string().min(1).max(200),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const inputReceiptResultSchema = z.object({
  version: z.literal(1),
  status: z.enum(["matched", "mismatch", "unavailable"]),
}).strict();
export type InputReceiptRequest = z.infer<typeof inputReceiptRequestSchema>;
export type InputReceiptResult = z.infer<typeof inputReceiptResultSchema>;
export type InputReceiptContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

// JSON string escaping preserves lone UTF-16 surrogates and distinguishes escaped
// characters. Base64 is emitted directly after validating its ASCII alphabet so
// native hashing need not allocate another copy of large image data.
export function* fingerprintInputSegments(content: readonly InputReceiptContent[]): Generator<string> {
  yield "omp-collab-input-receipt:v1\n[";
  for (let index = 0; index < content.length; index++) {
    if (index) yield ",";
    const item = content[index]!;
    if (item.type === "text") {
      yield '["text",';
      yield JSON.stringify(item.text);
      yield "]";
    } else if (item.type === "image") {
      const padding = item.data.endsWith("==") ? 2 : item.data.endsWith("=") ? 1 : 0;
      const invalid = /[^A-Za-z0-9+/]/.exec(item.data);
      const lastDataCharacter = item.data.charAt(item.data.length - padding - 1);
      if (item.data.length % 4 !== 0 || (invalid && invalid.index !== item.data.length - padding) ||
          (padding === 2 && !/[AQgw]/.test(lastDataCharacter)) ||
          (padding === 1 && !/[AEIMQUYcgkosw048]/.test(lastDataCharacter))) {
        throw new TypeError("Receipt image data must be canonical base64.");
      }
      yield '["image",';
      yield JSON.stringify(item.mimeType);
      yield ',"';
      yield item.data;
      yield '"]';
    } else {
      throw new TypeError("Unsupported receipt content.");
    }
  }
  yield "]";
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index++;
    } else length += 3;
  }
  return length;
}

export async function fingerprintInput(content: readonly InputReceiptContent[]): Promise<string> {
  const segments = Array.from(fingerprintInputSegments(content));
  const bytes = new Uint8Array(segments.reduce((length, segment) => length + utf8ByteLength(segment), 0));
  const encoder = new TextEncoder();
  let offset = 0;
  for (const segment of segments) {
    offset += encoder.encodeInto(segment, bytes.subarray(offset)).written;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
