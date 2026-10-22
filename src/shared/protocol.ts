import {
  MACHINE_DISPLAY_NAME_FORBIDDEN_CHARACTERS,
  MAXIMUM_MACHINE_DISPLAY_NAME_LENGTH,
} from "./machines";

import { z } from "zod";
import { inputReceiptRequestSchema, inputReceiptResultSchema } from "./collab-input-receipts";

export const SESSION_ROLES = ["coordinator", "participant"] as const;
export const DELIVERY_MODES = ["followUp", "nextTurn", "steer"] as const;
export const NOTIFICATION_KINDS = ["blocked", "completed"] as const;
export const NOTIFICATION_OUTCOMES = ["stop", "length", "toolUse", "error", "aborted"] as const;
export const NOTIFICATION_INPUT_TYPES = ["select", "editor"] as const;
export const NOTIFICATION_READ_STATES = ["unread", "all"] as const;
export const AUTOMATIC_COLLAB_ERROR_CODES = [
  "collab-api-unsupported",
  "collab-noninteractive",
  "collab-connection-unavailable",
  "collab-session-changed",
  "collab-stopped",
  "missing-or-invalid-collab-web-url",
  "invalid-collab-web-link",
  "invalid-collab-host",
  "invalid_room",
  "not-registered",
  "request-timeout",
  "request-send-failed",
  "room-update-failed",
  "room-update-send-failed",
  "socket-not-open",
  "too-many-pending-requests",
  "shutdown",
  "invalid-omp-executable",
  "omp-executable-unavailable",
  "collab-registry-timeout",
  "collab-registry-nonzero-exit",
  "collab-registry-output-limit",
  "collab-registry-malformed-json",
  "invalid-collab-registry-list",
  "invalid-collab-registry-link",
  "automatic-collab-failed",
] as const;

export const pcIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const sessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value !== "*", "Session IDs must not use the broadcast target.");
export const messageRecipientSchema = z.union([sessionIdSchema, z.literal("*")]);

export const sessionDescriptorSchema = z.object({
  pcId: pcIdSchema,
  sessionId: sessionIdSchema,
  instanceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  cwd: z.string().min(1).max(2_048),
  role: z.enum(SESSION_ROLES),
  idle: z.boolean(),
  connectedAt: z.string().datetime(),
});

export const collabRoomSchema = z.object({
  webLink: z.string().min(1).max(4_096),
  expiresAt: z.string().datetime(),
});

/** Producer-normalized registry failure facts; never error messages or output. */
export const registryDiagnosticFields = {
  registryAttemptId: z.string().uuid().optional(),
  registryStage: z.enum(["list", "link", "unknown"]).optional(),
  registryPhase: z.enum(["validation", "stat", "exec", "parse"]).optional(),
  registryErrno: z.enum(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOTDIR", "EISDIR", "E2BIG", "ENOMEM", "EMFILE", "ENFILE", "EBUSY", "ETXTBSY", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "UNKNOWN"]).optional(),
  registrySyscall: z.enum(["stat", "access", "spawn", "UNKNOWN"]).optional(),
  registrySignal: z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGHUP", "SIGQUIT", "SIGPIPE", "UNKNOWN"]).optional(),
  registryExitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  registryKilled: z.boolean().optional(),
  registryTimeout: z.boolean().optional(),
  registryElapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  registryStdoutBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  registryStderrBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};

export const automaticCollabDiagnosticSchema = z
  .object({
    enabled: z.boolean(),
    hostState: z.enum(["none", "ready", "reconnecting", "stopped"]),
    publicationState: z.enum(["acknowledged", "manual", "none", "pending"]),
    recoveryState: z.enum(["idle", "recovering", "suspended"]),
    errorCode: z.enum(AUTOMATIC_COLLAB_ERROR_CODES).nullable(),
    errorKind: z.enum(["known-code", "type-error", "unknown-error"]).nullable(),
    errorStage: z.enum(["ensure", "room-clear", "room-publication"]).nullable(),
    ...registryDiagnosticFields,
  })
  .strict();

export const dashboardSessionSchema = z.object({
  pcId: pcIdSchema,
  sessionId: sessionIdSchema,
  name: z.string().min(1).max(200),
  role: z.enum(SESSION_ROLES),
  idle: z.boolean(),
  needsInput: z.boolean(),
  connectedAt: z.string().datetime(),
  room: collabRoomSchema.nullable(),
  inputReceiptAvailable: z.boolean().optional(),
});

export const dashboardPcSchema = z
  .object({
    pcId: pcIdSchema,
    displayName: z.string().min(1).max(MAXIMUM_MACHINE_DISPLAY_NAME_LENGTH).refine(
      (value) => !MACHINE_DISPLAY_NAME_FORBIDDEN_CHARACTERS.test(value),
      "PC display names must not contain control characters.",
    ),
    online: z.boolean(),
  })
  .strict();

export const dashboardSessionsResponseSchema = z
  .object({
    pcs: z.array(dashboardPcSchema).max(10_000),
    sessions: z.array(dashboardSessionSchema).max(10_000),
  })
  .strict();

export const agentMessageSchema = z.object({
  messageId: z.string().uuid(),
  from: sessionIdSchema,
  to: messageRecipientSchema,
  text: z.string().min(1).max(32_000),
  delivery: z.enum(DELIVERY_MODES).default("followUp"),
  triggerTurn: z.boolean().default(false),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const notificationIdSchema = z.string().uuid().transform((value) => value.toLowerCase());

export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export const notificationOutcomeSchema = z.enum(NOTIFICATION_OUTCOMES);
export const notificationInputTypeSchema = z.enum(NOTIFICATION_INPUT_TYPES);
export const notificationReadStateSchema = z.enum(NOTIFICATION_READ_STATES);

const notificationContextBaseSchema = z.object({
  turnNumber: z.number().int().min(1).max(1_000_000_000),
  durationMs: z.number().int().min(0).max(2_592_000_000),
});

export const blockedNotificationContextSchema = notificationContextBaseSchema
  .extend({ inputType: notificationInputTypeSchema })
  .strict();
export const completedNotificationContextSchema = notificationContextBaseSchema
  .extend({ outcome: notificationOutcomeSchema })
  .strict();
export const terminalNotificationContextSchema = z.union([
  blockedNotificationContextSchema,
  completedNotificationContextSchema,
]);

export const notificationRecordSchema = z
  .object({
    pcId: pcIdSchema,
    notificationId: notificationIdSchema,
    sessionId: sessionIdSchema,
    sessionLabel: z.string().min(1).max(200),
    sessionName: z.string().min(1).max(200).nullable(),
    sessionRole: z.enum(SESSION_ROLES).nullable(),
    kind: notificationKindSchema,
    turnNumber: z.number().int().min(1).max(1_000_000_000).nullable(),
    durationMs: z.number().int().min(0).max(2_592_000_000).nullable(),
    outcome: notificationOutcomeSchema.nullable(),
    inputType: notificationInputTypeSchema.nullable(),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().nullable(),
    online: z.boolean(),
  })
  .strict();

export const notificationSnapshotSchema = notificationRecordSchema.omit({ online: true });

export const notificationListResponseSchema = z
  .object({
    notifications: z.array(notificationRecordSchema).max(100),
  })
  .strict();

const notificationChangeCursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const NotificationSessionSnapshotRequestSchema = z.object({
  version: z.literal(1),
  pcId: pcIdSchema,
  sessionId: sessionIdSchema,
  roomGeneration: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const NotificationSessionSnapshotResponseSchema = NotificationSessionSnapshotRequestSchema
  .omit({ roomGeneration: true }).extend({ throughChangeId: notificationChangeCursorSchema }).strict();
export const NotificationSessionReadRequestSchema = NotificationSessionSnapshotRequestSchema
  .extend({ throughChangeId: notificationChangeCursorSchema }).strict();
export const NotificationSessionReadResponseSchema = NotificationSessionSnapshotResponseSchema
  .extend({ updatedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export type NotificationSessionSnapshotRequest = z.infer<typeof NotificationSessionSnapshotRequestSchema>;
export type NotificationSessionSnapshotResponse = z.infer<typeof NotificationSessionSnapshotResponseSchema>;
export type NotificationSessionReadRequest = z.infer<typeof NotificationSessionReadRequestSchema>;
export type NotificationSessionReadResponse = z.infer<typeof NotificationSessionReadResponseSchema>;

export const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().min(1).max(4_096),
    expirationTime: z.number().finite().nonnegative().nullable(),
    keys: z
      .object({
        p256dh: z.string().min(1).max(512),
        auth: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

export const pushSubscriptionDeletionSchema = z
  .object({
    endpoint: z.string().min(1).max(4_096),
  })
  .strict();

export const brokerPushSubscriptionSchema = pushSubscriptionSchema
  .extend({
    ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
    authorizationExpiresAtMs: z.number().int().positive().max(8_640_000_000_000_000),
  })
  .strict();

export const brokerPushSubscriptionDeletionSchema = pushSubscriptionDeletionSchema
  .extend({
    ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const pushPublicKeyResponseSchema = z
  .object({
    publicKey: z.string().min(1).max(512),
  })
  .strict();

export const terminalNotificationFrameSchema = z
  .object({
    type: z.literal("terminal_notification"),
    requestId: z.string().uuid(),
    notificationId: notificationIdSchema,
    kind: notificationKindSchema,
    context: terminalNotificationContextSchema.optional(),
  })
  .strict()
  .superRefine((frame, issue) => {
    if (
      frame.context !== undefined &&
      !(frame.kind === "blocked"
        ? blockedNotificationContextSchema.safeParse(frame.context).success
        : completedNotificationContextSchema.safeParse(frame.context).success)
    ) {
      issue.addIssue({
        code: "custom",
        message: "Terminal notification context does not match its kind.",
        path: ["context"],
      });
    }
  });

// Private server-to-server voice lane; deliberately separate from the ordinary
// agent-message bus and the public collaboration protocol.
export const nativeVoiceBindingSchema = z.object({
  voiceId: z.string().uuid(),
  pcId: pcIdSchema,
  sessionId: sessionIdSchema,
  roomDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bindingGeneration: z.string().uuid(),
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  deadline: z.number().int().safe(),
}).strict();
export const voiceDelegationIdSchema = z.string().min(1).max(200).regex(/^[\w-]+$/);
const voiceCommandBaseSchema = z.object({
  voiceId: z.string().uuid(),
  bindingGeneration: z.string().uuid(),
}).strict();
export const voiceControlFrameSchema = z.discriminatedUnion("type", [
  nativeVoiceBindingSchema.extend({ type: z.literal("bind"), requestId: z.string().uuid() }),
  voiceCommandBaseSchema.extend({ type: z.literal("delegate"), requestId: z.string().uuid(),
    delegationId: voiceDelegationIdSchema, delegationGeneration: z.number().int().min(1).max(1_000_000),
    text: z.string().trim().min(1).max(16_384) }),
  voiceCommandBaseSchema.extend({ type: z.literal("renew"), requestId: z.string().uuid(), deadline: z.number().int().safe() }),
  voiceCommandBaseSchema.extend({ type: z.literal("close"), requestId: z.string().uuid() }),
]);
export const voiceHostCommandSchema = z.discriminatedUnion("type", [
  nativeVoiceBindingSchema.extend({ type: z.literal("voice_bind") }),
  voiceCommandBaseSchema.extend({ type: z.literal("voice_delegate"),
    delegationId: voiceDelegationIdSchema, delegationGeneration: z.number().int().min(1).max(1_000_000),
    text: z.string().trim().min(1).max(16_384) }),
  voiceCommandBaseSchema.extend({ type: z.literal("voice_renew"), deadline: z.number().int().safe() }),
  voiceCommandBaseSchema.extend({ type: z.literal("voice_close") }),
]);
export const voiceHostEventSchema = voiceCommandBaseSchema.extend({
  type: z.literal("voice_event"),
  event: z.enum(["bound", "observed", "commentary", "final", "unavailable", "closed"]),
  delegationId: voiceDelegationIdSchema.optional(),
  delegationGeneration: z.number().int().min(1).max(1_000_000).optional(),
  text: z.string().min(1).max(32_768).optional(),
  code: z.enum(["expired", "room_changed", "host_unavailable", "foreign_turn", "delivery_failed", "closed"]).optional(),
}).strict();
export function validVoiceEvent(frame: z.infer<typeof voiceHostEventSchema>): boolean {
  const hasDelegation = frame.event === "observed" || frame.event === "commentary" || frame.event === "final";
  return hasDelegation === (frame.delegationId !== undefined && frame.delegationGeneration !== undefined) &&
    ((frame.event === "commentary" || frame.event === "final") === (frame.text !== undefined));
}
export const voiceControlReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ack"), requestId: z.string().uuid(), voiceId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("error"), requestId: z.string().uuid(), code: z.enum([
    "unavailable", "room_changed", "expired", "invalid_state", "host_unavailable", "delivery_failed",
  ]) }).strict(),
  voiceHostEventSchema,
]);
export type NativeVoiceBinding = z.infer<typeof nativeVoiceBindingSchema>;
export type VoiceControlFrame = z.infer<typeof voiceControlFrameSchema>;
export type VoiceHostCommand = z.infer<typeof voiceHostCommandSchema>;
export type VoiceHostEvent = z.infer<typeof voiceHostEventSchema>;
export type VoiceControlReply = z.infer<typeof voiceControlReplySchema>;
export const clientFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("register"),
      session: sessionDescriptorSchema,
      inputReceiptAvailable: z.boolean().optional(),
      interactiveRoot: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("list"), requestId: z.string().uuid() }),
  z.object({ type: z.literal("send"), requestId: z.string().uuid(), message: agentMessageSchema }),
  z.object({ type: z.literal("ack"), messageId: z.string().uuid() }),
  z.object({ type: z.literal("presence"), idle: z.boolean() }),
  z.object({ type: z.literal("rename"), name: z.string().min(1).max(200) }),
  z.object({ type: z.literal("room_update"), requestId: z.string().uuid(), room: collabRoomSchema.nullable(),
    inputReceiptAvailable: z.boolean().optional() }),
  z.object({ type: z.literal("input_state"), needsInput: z.boolean() }),
  z.object({ type: z.literal("collab_status"), status: automaticCollabDiagnosticSchema }).strict(),
  z.object({ type: z.literal("input_receipt_result"), requestId: z.string().uuid(),
    result: inputReceiptResultSchema }).strict(),
  terminalNotificationFrameSchema,
  z.object({
    type: z.literal("notification_session_read"),
    requestId: z.string().uuid(),
    expectedSessionId: sessionIdSchema,
    expectedInstanceId: z.string().uuid(),
  }).strict(),
  z
    .object({
      type: z.literal("notification_inbox"),
      requestId: z.string().uuid(),
      readState: notificationReadStateSchema,
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("notification_read"),
      requestId: z.string().uuid(),
      notificationId: notificationIdSchema,
    })
    .strict(),
]);

export const serverFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("registered"),
      sessionId: sessionIdSchema,
      coordinator: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("sessions"), requestId: z.string().uuid(), sessions: z.array(sessionDescriptorSchema) }),
  z.object({ type: z.literal("message"), message: agentMessageSchema }),
  z.object({ type: z.literal("accepted"), requestId: z.string().uuid(), messageId: z.string().uuid() }),
  z.object({ type: z.literal("room_updated"), requestId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("input_receipt_request"), requestId: z.string().uuid(),
    receipt: inputReceiptRequestSchema }).strict(),
  z.object({
    type: z.literal("notification_session_read"),
    requestId: z.string().uuid(),
    sessionId: sessionIdSchema,
    updatedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z
    .object({
      type: z.literal("error"),
      requestId: z.string().uuid().optional(),
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      type: z.literal("notification_accepted"),
      requestId: z.string().uuid(),
      notificationId: notificationIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("notifications"),
      requestId: z.string().uuid(),
      notifications: z.array(notificationRecordSchema).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("notification_read"),
      requestId: z.string().uuid(),
      notificationId: notificationIdSchema,
    })
    .strict(),
]);

export type AutomaticCollabDiagnostic = z.infer<typeof automaticCollabDiagnosticSchema>;
export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type CollabRoom = z.infer<typeof collabRoomSchema>;
export type DashboardSession = z.infer<typeof dashboardSessionSchema>;
export type DashboardPc = z.infer<typeof dashboardPcSchema>;
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type NotificationKind = z.infer<typeof notificationKindSchema>;
export type NotificationOutcome = z.infer<typeof notificationOutcomeSchema>;
export type NotificationInputType = z.infer<typeof notificationInputTypeSchema>;
export type NotificationReadState = z.infer<typeof notificationReadStateSchema>;
export type TerminalNotificationContext = z.infer<typeof terminalNotificationContextSchema>;
export type NotificationSnapshot = z.infer<typeof notificationSnapshotSchema>;
export type NotificationRecord = z.infer<typeof notificationRecordSchema>;
export type ServerFrame = z.infer<typeof serverFrameSchema>;
