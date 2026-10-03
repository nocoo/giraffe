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
export const repositoryProgressSchema = z.object({
	tasks: z.array(z.number().int().positive()).max(100),
	worker: z.number().int().nullable(),
	reviewer: z.number().int().nullable(),
	round: z.number().int().min(0).max(20),
	findings: z.array(z.string().max(500)).max(8),
	head: z.string().nullable(),
	status: z.string().max(30),
	followup: z
		.object({
			checks: z.number().int().min(0).max(3),
			outcome: z.enum(["pending", "passed", "failed", "timeout"]),
		})
		.optional(),
});
export type RepositoryProgress = z.infer<typeof repositoryProgressSchema>;
export const workRunSchema = z.object({
	occurrence: z.string().min(1),
	events: z.array(z.string().max(1000)).max(40),
	updatedAt: z.string().datetime({ offset: true }),
	repositories: z.record(z.string(), repositoryProgressSchema).default({}),
});
export type WorkProgress = z.infer<typeof workRunSchema>;

export function boundedProgress(progress: WorkProgress): WorkProgress {
	const repositories = Object.fromEntries(
		Object.entries(progress.repositories)
			.slice(0, 25)
			.map(([name, value]) => [
				name,
				{
					...value,
					tasks: value.tasks.slice(0, 100),
					findings: value.findings.slice(0, 8).map((finding) => finding.slice(0, 500)),
				},
			]),
	);
	const value = {
		...progress,
		repositories,
		events: progress.events.slice(-40).map((event) => event.slice(0, 1000)),
	};
	while (new TextEncoder().encode(JSON.stringify(value)).length > 60000) {
		if (value.events.length) value.events.shift();
		else {
			const largest = Object.values(value.repositories).sort(
				(left, right) => right.findings.join("").length - left.findings.join("").length,
			)[0];
			if (!largest?.findings.length) throw new Error("Work summary exceeds payload budget.");
			largest.findings.pop();
		}
	}
	return value;
}
