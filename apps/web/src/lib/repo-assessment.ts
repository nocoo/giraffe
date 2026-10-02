import type { JudgmentResult, RepositoryReport } from "./ai-review";

export type RepoAssessment = {
	account_id: string;
	repo: string;
	status: "unconfigured" | "missing" | "judgment" | "summary" | "complete" | "failed";
	sourceVersion: string | null;
	sourceAt: string | null;
	reportVersion: string | null;
	reportAt: string | null;
	judgment: JudgmentResult | null;
	report: RepositoryReport | null;
	error: string | null;
};
