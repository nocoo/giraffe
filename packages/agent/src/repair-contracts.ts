import { z } from "zod";
import { repositorySchema } from "./contracts.ts";

export const MAX_REPAIR_ROUNDS = 20;
export const repairStageSchema = z.enum([
	"discovered",
	"planning",
	"preparing",
	"fixing",
	"checking",
	"reviewing",
	"signed_off",
	"pushing",
	"pushed",
	"blocked",
	"exhausted",
	"cancelled",
]);
export type RepairStage = z.infer<typeof repairStageSchema>;
export const issueCandidateSchema = z.strictObject({
	repository: repositorySchema,
	number: z.number().int().positive(),
	title: z.string().min(1).max(500),
	url: z.string().url(),
	labels: z.array(z.string()).max(100),
	updatedAt: z.string().datetime({ offset: true }),
	sourceVersion: z.string().min(1),
	fetchedAt: z.string().datetime({ offset: true }),
});
export type IssueCandidate = z.infer<typeof issueCandidateSchema>;
export const liveIssueSchema = issueCandidateSchema.extend({
	body: z.string().max(30000),
	state: z.literal("open"),
	author: z.string(),
	baseSha: z.string().regex(/^[a-f0-9]{40}$/),
	defaultBranch: z.string().min(1),
	repositoryId: z.string(),
	verifiedAt: z.string().datetime({ offset: true }),
});
export type LiveIssue = z.infer<typeof liveIssueSchema>;
export const dependencyPlanSchema = z
	.strictObject({
		decision: z.enum(["repair", "defer"]),
		reason: z.string().min(1).max(2000),
		manifest: z.string().regex(/^(?:[A-Za-z0-9_.-]+\/)*package\.json$/),
		section: z.enum([
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]),
		dependency: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/),
		targetVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
		provenance: z.enum(["original", "effective_fork", "unknown"]),
		provenanceReason: z.string().min(1).max(2000),
	})
	.refine(
		(value) => new TextEncoder().encode(JSON.stringify(value)).length <= 8000,
		"Plan exceeds its byte budget",
	);
export type DependencyPlan = z.infer<typeof dependencyPlanSchema>;
export const repairReviewSchema = z
	.strictObject({
		verdict: z.enum(["signoff", "changes_requested", "blocked"]),
		summary: z.string().min(1).max(3000),
		findings: z
			.array(
				z.strictObject({
					severity: z.enum(["P0", "P1", "P2", "P3"]),
					path: z.string().max(300),
					message: z.string().min(1).max(2000),
				}),
			)
			.max(20),
		head: z.string().regex(/^[a-f0-9]{40}$/),
		contentFingerprint: z.string().min(1),
		validationDigest: z.string().min(1),
		reviewedRound: z.number().int().min(1).max(MAX_REPAIR_ROUNDS),
	})
	.refine(
		(review) => review.verdict !== "signoff" || review.findings.length === 0,
		"Signoff cannot retain findings",
	)
	.refine(
		(value) => new TextEncoder().encode(JSON.stringify(value)).length <= 24000,
		"Review exceeds its byte budget",
	);
export type RepairReview = z.infer<typeof repairReviewSchema>;
export const repairProgressSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: z.string(),
	repository: repositorySchema,
	issueNumber: z.number().int().positive(),
	title: z.string(),
	issueUrl: z.string().url(),
	stage: repairStageSchema,
	round: z.number().int().min(0).max(MAX_REPAIR_ROUNDS),
	maxRounds: z.number().int().min(1).max(MAX_REPAIR_ROUNDS),
	branch: z.string().nullable(),
	head: z.string().nullable(),
	contentFingerprint: z.string().nullable(),
	workerConversationId: z.number().int().nullable(),
	reviewerConversationId: z.number().int().nullable(),
	startedAt: z.string(),
	updatedAt: z.string(),
	sequence: z.number().int().nonnegative(),
	reason: z.string().max(3000),
	plan: dependencyPlanSchema.nullable(),
	review: repairReviewSchema.nullable(),
	events: z
		.array(
			z.strictObject({
				at: z.string(),
				stage: repairStageSchema,
				round: z.number().int(),
				message: z.string().max(2000),
			}),
		)
		.max(80),
});
export type RepairProgress = z.infer<typeof repairProgressSchema>;
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
	capability: z.literal("dependency-upgrades"),
	maxRounds: z.number().int().min(1).max(MAX_REPAIR_ROUNDS),
});
export type CronStatus = z.infer<typeof cronStatusSchema>;
