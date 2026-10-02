import type { JudgmentResult, RepositoryReport } from "../../lib/ai-review";
import type { AssessmentDigest } from "../../lib/assessment-digest";
import { aiConfigured } from "./ai-assessment";
import type { Db } from "./db/d1";
import type { repoPolicy } from "./repo-statistics";

type Row = {
	repo: string;
	stage: AssessmentDigest["status"];
	source_version: string;
	judgment: string | null;
	report: string | null;
	report_version: string | null;
	report_at: string | null;
	error: string | null;
	current_version: string | null;
};

const MAX_ACTIONS = 3;
const MAX_FLAGS = 8;

function parse<T>(text: string | null): T | null {
	if (!text) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

export function digestRow(row: Row): AssessmentDigest {
	const report = parse<RepositoryReport>(row.report);
	const judgment = parse<JudgmentResult>(row.judgment);
	const flags: AssessmentDigest["flags"] = [];
	for (const j of judgment?.judgments ?? [])
		if (j.choice === "urgent" || j.choice === "review")
			flags.push({ id: j.id, choice: j.choice, uncertain: j.uncertain });
	flags.sort((a, b) => Number(a.choice === "review") - Number(b.choice === "review"));
	const actions: AssessmentDigest["actions"] = [];
	for (const a of report?.actions ?? [])
		if (a.priority === "now" || a.priority === "next")
			actions.push({ priority: a.priority, title: a.title });
	actions.sort((a, b) => Number(a.priority === "next") - Number(b.priority === "next"));
	return {
		repo: row.repo,
		status: row.stage,
		// A report is current only while it describes the repository version now published.
		current: Boolean(report && row.report_version && row.report_version === row.current_version),
		reportAt: report ? row.report_at : null,
		overall: report?.overall ?? null,
		sections: report
			? {
					security: report.security.status,
					pullRequests: report.pullRequests.status,
					issues: report.issues.status,
					delivery: report.delivery.status,
				}
			: null,
		trend: report?.delivery.trend ?? null,
		actions: actions.slice(0, MAX_ACTIONS),
		flags: flags.slice(0, MAX_FLAGS),
		error: row.stage === "failed" ? row.error : null,
	};
}

export async function assessmentDigests(
	db: Db,
	account: string,
	policy: Awaited<ReturnType<typeof repoPolicy>>,
) {
	const known = new Map(policy.repos.map((r) => [r.name_with_owner.toLowerCase(), r]));
	const rows = await db
		.prepare(
			"SELECT r.repo,r.stage,r.source_version,r.judgment,r.report,r.report_version,r.report_at,r.error,s.version AS current_version FROM ai_reviews r LEFT JOIN factory_repo_state s ON s.account_id=r.account_id AND s.repo=r.repo WHERE r.account_id=? ORDER BY r.repo",
		)
		.bind(account)
		.all<Row>();
	return {
		configured: await aiConfigured(db),
		items: rows.results
			.filter((row) => known.has(row.repo.toLowerCase()) && policy.enabled(row.repo))
			.map(digestRow),
	};
}
