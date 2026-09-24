import type { JudgmentPriority, RepositoryReport } from "./ai-review";
import type { RepoAssessment } from "./repo-assessment";

type Status = RepositoryReport["overall"];

/** Compact, read-only projection of one saved assessment for cross-repository ranking. */
export type AssessmentDigest = {
	repo: string;
	status: Exclude<RepoAssessment["status"], "unconfigured" | "missing">;
	current: boolean;
	reportAt: string | null;
	overall: Status | null;
	sections: Record<"security" | "pullRequests" | "issues" | "delivery", Status> | null;
	trend: RepositoryReport["delivery"]["trend"] | null;
	actions: { priority: "now" | "next"; title: string }[];
	flags: {
		id: string;
		choice: Extract<JudgmentPriority, "urgent" | "review">;
		uncertain: boolean;
	}[];
	error: string | null;
};

export type AssessmentDigests = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	configured: boolean;
	items: AssessmentDigest[];
};
