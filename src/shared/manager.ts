import { z } from "zod";
import { inspectOperationSchema, inspectResultSchema } from "./session-consult";
import { notificationSnapshotSchema } from "./notification-schema";

const uuid = z.string().uuid();
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const inputRevision = epoch;
const pcId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const sessionId = z.string().min(1).max(200).refine(value => value !== "*");
export const MANAGER_RECORD_BYTES = 128 * 1024;
export const MANAGER_RESPONSE_BYTES = 512 * 1024;
export const managerErrorCodeSchema = z.enum(["not_authorized", "manager_unavailable", "runtime_unavailable", "activation_required", "assignment_inactive", "revision_conflict", "target_conflict", "stale_target", "input_changed", "question_changed", "steer_disabled", "needs_owner", "busy", "capacity", "expired", "outcome_unknown", "invalid_request", "storage_unavailable"]);
export type ManagerErrorCode = z.infer<typeof managerErrorCodeSchema>;
export const managerTargetSchema = z.object({ pcId, sessionId, instanceId: uuid }).strict();
export type ManagerTarget = z.infer<typeof managerTargetSchema>;
export const managerBindingSchema = z.object({ managerId: uuid, hostPcId: pcId, launchId: uuid, sessionId, instanceId: uuid, generation: revision }).strict();
export type ManagerBinding = z.infer<typeof managerBindingSchema>;
export const managerActionStateSchema = z.enum(["queued", "dispatching", "admitted", "confirmed", "superseded", "rejected", "expired", "unknown"]);
export type ManagerActionState = z.infer<typeof managerActionStateSchema>;
export const managerActionReceiptSchema = z.object({ actionId: uuid, state: managerActionStateSchema, code: managerErrorCodeSchema.optional(), createdAt: epoch, updatedAt: epoch, expiresAt: epoch }).strict();
export type ManagerActionReceipt = z.infer<typeof managerActionReceiptSchema>;
export const managerQuestionSchema = z.object({ target: managerTargetSchema, questionToken: z.string().min(1).max(256), contextRevision: z.string().min(1).max(256), inputRevision,
  kind: z.enum(["select", "editor"]), title: z.string().max(16000), options: z.array(z.string().max(16000)).max(256).optional(),
  selectionMarker: z.enum(["radio", "checkbox"]).optional(), checkedIndices: z.array(epoch).max(256).optional(), markableCount: epoch.optional(),
  askToolCallId: z.string().min(1).max(200).optional(), askQuestionId: z.string().min(1).max(200).optional(), routineEligible: z.boolean(), observedAt: epoch }).strict();
export type ManagerQuestion = z.infer<typeof managerQuestionSchema>;
export const managerSessionStatusSchema = z.object({ target: managerTargetSchema, name: z.string().min(1).max(200), cwd: z.string().max(2048), role: z.enum(["coordinator", "participant"]), managedAgent: z.enum(["sentinel", "manager"]).optional(), online: z.boolean(), idle: z.boolean(), needsInput: z.boolean(), inputRevision: inputRevision.nullable(), managementAvailable: z.boolean(), allowSteer: z.boolean(), observedAt: epoch, task: z.null() }).strict();
export type ManagerSessionStatus = z.infer<typeof managerSessionStatusSchema>;
export const managerPageKindSchema = z.enum(["sessions"]);
export const managerCursorSchema = z.object({ v: z.literal(1), kind: managerPageKindSchema, lastKey: z.string().min(1).max(1400) }).strict();
export const managerPageSchema = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item).max(100), total: epoch, nextCursor: z.string().min(1).max(2048).nullable() }).strict();
export const managerHumanOperationReceiptSchema = z.object({ operationId: uuid, state: z.enum(["applied", "unknown", "rejected"]), code: managerErrorCodeSchema.optional() }).strict();
export const managerSnapshotSchema = z.object({ manager: z.object({ id: uuid.nullable(), hostPcId: pcId.nullable(), lifecycle: z.enum(["unconfigured", "starting", "online", "offline", "unknown", "unavailable"]), binding: managerBindingSchema.nullable() }).strict(), observedAt: epoch, operation: managerHumanOperationReceiptSchema.optional() }).strict();
export type ManagerSnapshot = z.infer<typeof managerSnapshotSchema>;
const managerChangesFields = { from: epoch, to: epoch, cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100) };
const managerChangesResultSchema = z.object({ kind: z.literal("changes"), sessionId, from: epoch, to: epoch, entries: z.array(z.object({ at: epoch, text: z.string().max(8000) }).strict()).max(100), nextCursor: z.string().max(2048).nullable(), truncated: z.boolean(), coverage: z.object({ from: epoch, to: epoch, complete: z.boolean(), gaps: z.array(z.string().max(256)).max(16) }).strict() }).strict();
export const managerNotificationSchema = notificationSnapshotSchema.extend({ title: z.string().max(200), body: z.string().max(1000) }).strict();
export type ManagerNotification = z.infer<typeof managerNotificationSchema>;
export const managerOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("list"), cursor: z.string().max(2048).optional() }).strict(),
  z.object({ kind: z.literal("inspect"), target: managerTargetSchema, operation: inspectOperationSchema }).strict(),
  z.object({ kind: z.literal("changes"), target: managerTargetSchema, ...managerChangesFields }).strict().refine(value => value.to >= value.from && value.to - value.from <= 1800000, "Invalid changes window"),
  z.object({ kind: z.literal("notifications"), from: epoch, to: epoch, limit: z.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(2048).optional() }).strict().refine(value => value.to >= value.from && value.to <= Date.now(), "Invalid notifications window"),
]);
export type ManagerOperation = z.infer<typeof managerOperationSchema>;
export const managerValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), snapshot: managerSnapshotSchema }).strict(),
  z.object({ kind: z.literal("list"), page: managerPageSchema(managerSessionStatusSchema) }).strict(),
  z.object({ kind: z.literal("inspect"), result: inspectResultSchema }).strict(),
  z.object({ kind: z.literal("changes"), target: managerTargetSchema, result: managerChangesResultSchema }).strict(),
  z.object({ kind: z.literal("notifications"), page: z.object({ items: z.array(managerNotificationSchema).max(100), nextCursor: z.string().min(1).max(2048).nullable() }).strict(), coverage: z.object({ from: epoch, to: epoch, complete: z.boolean(), gaps: z.array(z.string().max(256)).max(16) }).strict() }).strict(),
]);
export const managerResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), value: managerValueSchema }).strict(), z.object({ ok: z.literal(false), code: managerErrorCodeSchema }).strict()]);
export type ManagerResult = z.infer<typeof managerResultSchema>;
export const managerRequestSchema = z.object({ type: z.literal("manager_request"), requestId: uuid, operation: managerOperationSchema }).strict();
export const managerResultFrameSchema = z.object({ type: z.literal("manager_result"), requestId: uuid, result: managerResultSchema }).strict();
export const managerCancelSchema = z.object({ type: z.literal("manager_cancel"), requestId: uuid }).strict();
export const actionClaimSchema = z.object({ claimId: uuid, actionId: uuid, actor: z.literal("sentinel"), target: managerTargetSchema, inputRevision, askKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), owner: z.object({ runtimeLeaseId: uuid, reviewerSessionId: sessionId, reviewerInstanceId: uuid }).strict(), runtimeLeaseId: uuid, expiresAt: epoch }).strict();
export type ActionClaim = z.infer<typeof actionClaimSchema>;

export const managerHumanOperationSchema = z.discriminatedUnion("kind", [
  z.object({ operationId: uuid, kind: z.literal("start"), hostPcId: pcId }).strict(),
]);
export type ManagerHumanOperation = z.infer<typeof managerHumanOperationSchema>;
const runtimeBase = { operationId: uuid, expiresAt: epoch };
export const managerRuntimeCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...runtimeBase, kind: z.literal("ensure"), managerId: uuid }).strict(),
  z.object({ ...runtimeBase, kind: z.literal("status"), managerId: uuid }).strict(),
  z.object({ kind: z.literal("bind_challenge"), managerId: uuid, launchId: uuid, sessionId, instanceId: uuid, connectionId: uuid, runtimeLeaseId: uuid, challengeId: uuid, nonce: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: epoch }).strict(),
  z.object({ ...runtimeBase, kind: z.literal("question_inspect"), target: managerTargetSchema }).strict(),
  z.object({ ...runtimeBase, kind: z.literal("question_respond"), target: managerTargetSchema, questionToken: z.string().min(1).max(256), value: z.string().max(16000).nullable(), claim: actionClaimSchema }).strict(),
  z.object({ kind: z.literal("cancel"), operationId: uuid }).strict(),
]);
export type ManagerRuntimeCommand = z.infer<typeof managerRuntimeCommandSchema>;
export const managerRuntimeValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("binding"), managerId: uuid, launchId: uuid.optional(), sessionId: sessionId.optional(), instanceId: uuid.optional(), phase: z.enum(["starting", "ready", "stopped", "unknown", "failed"]) }).strict(),
  z.object({ kind: z.literal("bind_challenge"), challengeId: uuid, written: z.boolean() }).strict(),
  z.object({ kind: z.literal("question"), question: managerQuestionSchema.nullable(), askKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), hostGeneration: epoch.optional() }).strict(),
  z.object({ kind: z.literal("action"), receipt: managerActionReceiptSchema }).strict(),
  z.object({ kind: z.literal("ask_closed"), actionId: uuid, target: managerTargetSchema, askKey: z.string().regex(/^[a-f0-9]{64}$/), hostGeneration: epoch }).strict(),
  z.object({ kind: z.literal("cancel"), operationId: uuid }).strict(),
]);
export const managerRuntimeEventResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: managerRuntimeValueSchema }).strict(),
  z.object({ ok: z.literal(false), code: managerErrorCodeSchema }).strict(),
]);
export const managerRuntimeCommandFrameSchema = z.object({ type: z.literal("manager_runtime_command"), requestId: uuid, command: managerRuntimeCommandSchema }).strict();
export const managerRuntimeEventSchema = z.object({ type: z.literal("manager_runtime_event"), leaseId: uuid, requestId: uuid, result: managerRuntimeEventResultSchema }).strict();
export const managerRuntimeOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runtime_question_list") }).strict(),
  z.object({ kind: z.literal("claim"), actor: z.literal("sentinel"), target: managerTargetSchema, inputRevision, effectKey: z.string().min(1).max(256), questionToken: z.string().min(1).max(256).optional(), expiresAt: epoch }).strict(),
  z.object({ kind: z.literal("claim_result"), claimId: uuid, state: z.enum(["admitted", "confirmed", "rejected", "unknown"]), code: managerErrorCodeSchema.optional() }).strict(),
  z.object({ kind: z.literal("claim_release"), claimId: uuid }).strict(),
]);
export type ManagerRuntimeOperation = z.infer<typeof managerRuntimeOperationSchema>;
export const managerRuntimeRequestSchema = z.object({ type: z.literal("manager_runtime_request"), leaseId: uuid, requestId: uuid, operation: managerRuntimeOperationSchema }).strict();
export const managerRuntimeRequestResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("runtime_question_list"), sessions: z.array(managerSessionStatusSchema.extend({ pendingToolApproval: z.boolean() }).strict()).max(512) }).strict(),
    z.object({ kind: z.literal("claim"), claim: actionClaimSchema }).strict(),
    z.object({ kind: z.literal("claim_result"), claimId: uuid }).strict(),
    z.object({ kind: z.literal("claim_release"), claimId: uuid }).strict(),
  ]) }).strict(),
  z.object({ ok: z.literal(false), code: managerErrorCodeSchema }).strict(),
]);
export const managerRuntimeResultFrameSchema = z.object({ type: z.literal("manager_runtime_result"), requestId: uuid, result: managerRuntimeRequestResultSchema }).strict();
export const managerBindProofSchema = z.object({ type: z.literal("manager_bind_proof"), challengeId: uuid, connectionId: uuid, nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const managementStateSchema = z.object({ type: z.literal("management_state"), inputRevision, pendingToolApproval: z.boolean() }).strict();
