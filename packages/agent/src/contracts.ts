import { z } from "zod";

export const DOMAINS = ["issues", "prs", "ci", "cd"] as const;
export const domainSchema = z.enum(DOMAINS);
export type Domain = z.infer<typeof domainSchema>;
export const scopeSchema = z.enum(["repo", "global"]);
export const verdictSchema = z.enum(["pass", "attention", "fail", "unknown"]);
export const prioritySchema = z.enum(["routine", "review", "urgent", "unknown"]);
export const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const text = z.string().trim().min(1).max(4000);
const time = z.string().datetime({ offset: true });
const probability = z.number().min(0).max(1);

export const observationSchema = z.object({
	account_id: z.string().min(1),
	data: z.record(z.string(), z.unknown()),
	sourceVersion: z.string().min(1),
	fetchedAt: z.string().nullable(),
	freshness: z.unknown(),
	coverage: z.unknown(),
	truncated: z.boolean(),
	unavailable: z.boolean(),
	source: z.object({
		kind: z.string(),
		resource: z.string(),
		publicationId: z.string().nullable(),
	}),
	selection: z.object({
		scope: z.enum(["all", "starred"]),
		statisticsFilter: z.boolean(),
	}),
});
export type Observation = z.infer<typeof observationSchema>;

export const resourceSchema = z.object({
	id: z.string(),
	account_id: z.string(),
	repository: z.string().nullable(),
	type: z.string(),
	status: z.string(),
	source_version: z.string().nullable(),
	payload: z.record(z.string(), z.unknown()),
	revision: z.number().int().positive(),
	created_at: time,
	updated_at: time,
});
export type Resource = z.infer<typeof resourceSchema>;

export const sourceSchema = z.strictObject({
	resource: z.string(),
	version: z.string().nullable(),
	fetchedAt: z.string().nullable(),
	complete: z.boolean(),
	stale: z.boolean(),
});
export type Source = z.infer<typeof sourceSchema>;
export const evidenceSchema = z.strictObject({
	id: z.string().min(1).max(256),
	repository: repositorySchema.nullable(),
	kind: z.string().max(40),
	title: z.string().max(300),
	state: z.string().max(60),
	detail: z.string().max(900),
	url: z.string().url().nullable(),
	at: z.string().nullable(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const judgmentSchema = z
	.strictObject({
		model: z.string().min(1),
		choice: prioritySchema,
		confidence: probability,
		probabilities: z.strictObject({
			routine: probability,
			review: probability,
			urgent: probability,
			unknown: probability,
		}),
	})
	.superRefine((value, ctx) => {
		const values = Object.values(value.probabilities);
		if (
			Math.abs(values.reduce((sum, item) => sum + item, 0) - 1) > 0.001 ||
			value.probabilities[value.choice] < Math.max(...values)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Invalid decision distribution",
			});
		}
	});
export type Judgment = z.infer<typeof judgmentSchema>;

export const specialistSchema = z.strictObject({
	verdict: verdictSchema,
	summary: text,
	findings: z
		.array(
			z.strictObject({
				title: z.string().min(1).max(200),
				detail: text,
				evidenceIds: z.array(z.string()).max(20),
			}),
		)
		.max(8),
	actions: z
		.array(
			z.strictObject({
				title: z.string().min(1).max(200),
				reason: text,
				priority: z.enum(["now", "next", "later"]),
			}),
		)
		.max(6),
	limitations: z.array(z.string().min(1).max(1000)).max(20),
});
export type SpecialistResult = z.infer<typeof specialistSchema>;

export const analysisReportSchema = specialistSchema.extend({
	schemaVersion: z.literal(1),
	scope: scopeSchema,
	repository: repositorySchema.nullable(),
	domain: domainSchema,
	sourceVersion: z.string().min(1),
	observedAt: time,
	generatedAt: time,
	sources: z.array(sourceSchema).max(500),
	evidence: z.array(evidenceSchema).max(24),
	omitted: z.number().int().nonnegative(),
	judgment: judgmentSchema,
	producer: z.strictObject({
		orchestrator: z.string(),
		executor: z.string(),
		decision: z.string(),
		conversationId: z.number().int(),
		jobId: z.string(),
	}),
});
export type AnalysisReport = z.infer<typeof analysisReportSchema>;
