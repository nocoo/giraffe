import { z } from "zod";
import type {
	FactoryCoverage,
	FactoryDay,
	FactoryEvent,
	FactoryMetrics,
	FactoryStreamName,
	FactoryWindow,
} from "./factory-types";

export type ReviewEvidence = FactoryEvent & { excerpted?: boolean };
type ReviewPeriod = { window: FactoryWindow; activity: FactoryDay };

export type ReviewInput = {
	repository: {
		id: string;
		name: string;
		url: string;
		owner: string;
		description: string | null;
		language: string;
		archived: boolean;
		fork: boolean;
	};
	version: string;
	window: FactoryWindow;
	sampledAt: string;
	metrics: FactoryMetrics;
	focus: { recent: ReviewPeriod; previous: ReviewPeriod };
	coverage: Record<FactoryStreamName, FactoryCoverage>;
	events: Record<FactoryStreamName, ReviewEvidence[]>;
	omitted: Record<FactoryStreamName, number>;
	excluded: Record<FactoryStreamName, number>;
};

export type JudgmentPriority = "urgent" | "review" | "routine" | "unknown";
export type Judgment = {
	id: string;
	question: string;
	evidenceIds: string[];
	choice: JudgmentPriority;
	confidence: number;
	probabilities: Record<JudgmentPriority, number>;
	uncertain: boolean;
};
export type JudgmentResult = { model: string; judgments: Judgment[] } & (
	| { templateVersion: 1 }
	| { templateVersion: 2; focusWindow: FactoryWindow }
);

const text = z.string().trim().min(1).max(4000);
const evidenceIds = z.array(z.string().min(1).max(256)).max(40);
const status = z.enum(["healthy", "attention", "urgent", "unknown"]);
const section = z.strictObject({ status, summary: text, evidenceIds });

export const repositoryReportSchema = z.strictObject({
	schemaVersion: z.literal(1),
	summary: text,
	overall: status,
	security: section,
	pullRequests: section,
	issues: section,
	delivery: section.extend({
		trend: z.enum(["accelerating", "steady", "slowing", "inactive", "unknown"]),
	}),
	actions: z
		.array(
			z.strictObject({
				priority: z.enum(["now", "next", "later"]),
				title: z.string().trim().min(1).max(200),
				reason: text,
				evidenceIds,
			}),
		)
		.max(12),
	limitations: z.array(text).max(20),
});

export type RepositoryReport = z.infer<typeof repositoryReportSchema>;
