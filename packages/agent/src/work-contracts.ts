import { z } from "zod";

export const cronStatusSchema = z.strictObject({
	schemaVersion: z.literal(1),
	expression: z.string(),
	timezone: z.string(),
	enabled: z.boolean(),
	paused: z.boolean(),
	state: z.enum(["idle", "running", "offline", "error"]),
	nextRunAt: z.string(),
	lastRunAt: z.string().nullable(),
	activeOccurrence: z.string().nullable(),
	lastSeenAt: z.string(),
	completed: z.number().int(),
	lastError: z.string().nullable(),
	capability: z.literal("authorized-work"),
	maxRounds: z.literal(20),
});
export type CronStatus = z.infer<typeof cronStatusSchema>;
export const workRunSchema = z.object({
	occurrence: z.string().min(1),
	events: z.array(z.string().max(1000)).max(40),
	updatedAt: z.string().datetime({ offset: true }),
	repositories: z.record(z.string(), z.unknown()).optional(),
});
