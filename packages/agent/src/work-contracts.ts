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
	tasks: z.array(z.string().regex(/^(dependency|pr|ci):[1-9]\d*$/)).max(100),
	compactTasks: z.string().max(2000).optional(),
	workerModel: z.string().max(100).optional(),
	reviewerModel: z.string().max(100).optional(),
	dispositionOutcomes: z
		.string()
		.regex(/^[CND-]*$/)
		.max(100)
		.optional(),
	detailsOmitted: z.boolean().optional(),
	dispositions: z
		.array(
			z.object({
				task: z.string().max(100),
				outcome: z.enum(["committed", "reviewed_no_change", "deferred"]),
				reason: z.string().max(500).optional(),
			}),
		)
		.max(100)
		.optional(),
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
	analysisAttention: z.boolean().optional(),
	repositories: z
		.record(
			z.string(),
			repositoryProgressSchema.transform((value) => ({
				...value,
				tasks: value.compactTasks
					? value.compactTasks
							.split(",")
							.map(
								(task) =>
									`${task[0] === "d" ? "dependency" : task[0] === "p" ? "pr" : "ci"}:${task.slice(1)}`,
							)
					: value.tasks,
			})),
		)
		.default({}),
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
					...(value.dispositions
						? {
								dispositions: value.dispositions.slice(0, 100).map((item) => ({
									...item,
									...(item.reason ? { reason: item.reason.slice(0, 500) } : {}),
								})),
							}
						: {}),
				},
			]),
	);
	const value = {
		...progress,
		repositories,
		events: progress.events.slice(-40).map((event) => event.slice(0, 1000)),
	};
	while (new TextEncoder().encode(JSON.stringify(value)).length > 60000) {
		const detailed = Object.values(value.repositories).find((repo) => repo.dispositions?.length);
		if (detailed) {
			detailed.dispositionOutcomes = detailed.tasks
				.map((task) => {
					const outcome = detailed.dispositions?.find((item) => item.task === task)?.outcome;
					return outcome === "committed"
						? "C"
						: outcome === "reviewed_no_change"
							? "N"
							: outcome === "deferred"
								? "D"
								: "-";
				})
				.join("");
			detailed.detailsOmitted = true;
			delete detailed.dispositions;
		} else if (value.events.length) value.events.shift();
		else {
			const verbose = Object.values(value.repositories).find((repo) => repo.tasks.length);
			if (verbose) {
				verbose.compactTasks = verbose.tasks
					.map((task) => task.replace("dependency:", "d").replace("pr:", "p").replace("ci:", "c"))
					.join(",");
				verbose.tasks = [];
				continue;
			}
			const largest = Object.values(value.repositories).sort(
				(left, right) => right.findings.join("").length - left.findings.join("").length,
			)[0];
			if (!largest?.findings.length) throw new Error("Work summary exceeds payload budget.");
			largest.findings.pop();
		}
	}
	return value;
}
