import { z } from "zod";

export const SESSION_ROLES = ["coordinator", "participant"] as const;
export const NOTIFICATION_KINDS = ["blocked", "completed"] as const;
export const NOTIFICATION_OUTCOMES = ["stop", "length", "toolUse", "error", "aborted"] as const;
export const NOTIFICATION_INPUT_TYPES = ["select", "editor"] as const;
export const NOTIFICATION_READ_STATES = ["unread", "all"] as const;
export const pcIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const sessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value !== "*", "Session IDs must not use the broadcast target.");
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
