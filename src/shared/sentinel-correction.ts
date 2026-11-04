import { z } from 'zod';

export const sentinelCorrectionStatusSchema = z.enum(['context_admitted', 'expired', 'cancelled', 'unavailable', 'unsupported_host']);
export const sentinelCorrectionRequestSchema = z.object({
  type: z.literal('sentinel_correction_request'), requestId: z.string().uuid(),
  sessionId: z.string().min(1).max(200), instanceId: z.string().uuid(),
  text: z.string().min(1).max(16_000), expiresAt: z.number().int().positive(),
}).strict();
export const sentinelCorrectionCancelSchema = z.object({ type: z.literal('sentinel_correction_cancel'), requestId: z.string().uuid() }).strict();
export const sentinelCorrectionResultSchema = z.object({
  type: z.literal('sentinel_correction_result'), requestId: z.string().uuid(),
  status: sentinelCorrectionStatusSchema,
}).strict();
export type SentinelCorrectionRequest = z.infer<typeof sentinelCorrectionRequestSchema>;
export type SentinelCorrectionStatus = z.infer<typeof sentinelCorrectionStatusSchema>;
