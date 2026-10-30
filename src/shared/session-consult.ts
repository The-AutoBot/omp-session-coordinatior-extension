import { z } from "zod";

const sessionId = z.string().min(1).max(200).refine(value => value !== "*");
const index = z.number().int().nonnegative();
// A cursor is valid only for its captured host instance, exact revision and short lease.
export const snapshotCursorSchema = z.object({
  snapshotId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  part: index, offset: index,
}).strict();
export const inspectOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("history"), entryIndex: index.default(0), offset: index.default(0), throughEntryCount: index.optional() }).strict(),
  z.object({ kind: z.literal("question"), question: z.string().min(1).max(16_000) }).strict(),
  z.object({ kind: z.literal("snapshot"), cursor: snapshotCursorSchema.optional() }).strict(),
  z.object({
    kind: z.literal("intervene"), snapshotId: z.string().uuid(), expectedInstanceId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().min(1).max(16_000),
    delivery: z.enum(["followUp", "steer"]), expiresAt: z.number().int().positive(), source: z.literal("sentinel"),
  }).strict(),
]);
export const inspectResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("history"), sessionId, throughEntryCount: index, entryIndex: index, offset: index, text: z.string().max(32_000), next: z.object({ entryIndex: index, offset: index }).strict().nullable() }).strict(),
  z.object({ kind: z.literal("answer"), sessionId, text: z.string().max(256_000) }).strict(),
  z.object({
    kind: z.literal("snapshot"), sessionId, instanceId: z.string().uuid(),
    snapshotId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    part: index, offset: index, text: z.string().max(32_000),
    next: snapshotCursorSchema.nullable(),
  }).strict(),
  z.object({ kind: z.literal("intervention"), sessionId, delivered: z.literal(true) }).strict(),
  z.object({ kind: z.literal("error"), code: z.enum(["unsupported_host", "unavailable", "cancelled", "invalid_cursor", "question_failed", "answer_too_large", "snapshot_too_large", "steering_disabled", "expired"]) }).strict(),
]);
export const inspectClientRequestSchema = z.object({ type: z.literal("session_inspect"), requestId: z.string().uuid(), to: sessionId, operation: inspectOperationSchema }).strict();
export const inspectClientResultSchema = z.object({ type: z.literal("session_inspect_result"), requestId: z.string().uuid(), result: inspectResultSchema }).strict();
export const inspectCancelSchema = z.object({ type: z.literal("session_inspect_cancel"), requestId: z.string().uuid() }).strict();
export const inspectHostRequestSchema = z.object({ type: z.literal("session_inspect_request"), requestId: z.string().uuid(), operation: inspectOperationSchema }).strict();
export const inspectResponseSchema = z.object({ type: z.literal("session_inspect_response"), requestId: z.string().uuid(), result: inspectResultSchema }).strict();
export type InspectOperation = z.infer<typeof inspectOperationSchema>;
export type InspectResult = z.infer<typeof inspectResultSchema>;
