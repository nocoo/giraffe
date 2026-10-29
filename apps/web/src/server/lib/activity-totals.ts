import type { ActivityRepo, ActivitySnapshot } from "../../lib/activity-types";
import { activityTotals } from "./activity";
import { contentVersion } from "./content-version";

type Metric = keyof ActivitySnapshot["totals"];
type Missing = {
	repo: string | null;
	metrics: Metric[];
	reason: "partial" | "unavailable" | "missing_evidence" | "omitted";
};
const numericMetrics = [
	"ci_runs",
	"merged_prs",
	"dependency_prs",
	"other_prs",
	"issues_opened",
	"issues_closed",
	"releases",
] as const;
const metrics = [...numericMetrics, "red_default_branch"] as const;
const streams: Record<Metric, string[]> = {
	ci_runs: ["actions"],
	merged_prs: ["prs"],
	dependency_prs: ["prs", "pr_classification"],
	other_prs: ["prs", "pr_classification"],
	issues_opened: ["issues"],
	issues_closed: ["issues"],
	releases: ["releases"],
	red_default_branch: ["actions", "default_branch"],
};

export function readActivityTotals(
	repos: ActivityRepo[],
	membership = repos.map((repo) => repo.repo),
	unknownOmitted = false,
) {
	const missing: Missing[] = [];
	const perRepo = repos.map((repo) => {
		const totals = activityTotals([repo]);
		for (const metric of metrics) {
			if (totals[metric] !== null) continue;
			const status = streams[metric]
				.map((stream) => repo.coverage[stream]?.status)
				.find((status) => status !== "complete");
			const reason = status === "partial" || status === "unavailable" ? status : "missing_evidence";
			const entry = missing.find((entry) => entry.repo === repo.repo && entry.reason === reason);
			if (entry) entry.metrics.push(metric);
			else missing.push({ repo: repo.repo, metrics: [metric], reason });
		}
		return totals;
	});
	const present = new Set(repos.map((repo) => repo.repo.toLowerCase()));
	for (const repo of membership)
		if (!present.has(repo.toLowerCase()))
			missing.push({ repo, metrics: [...metrics], reason: "omitted" });
	if (unknownOmitted) missing.push({ repo: null, metrics: [...metrics], reason: "omitted" });
	const empty = repos.length === 0 && membership.length === 0 && !unknownOmitted;
	const totals = activityTotals([]);
	for (const metric of numericMetrics) {
		const available = perRepo.flatMap((total) => (total[metric] === null ? [] : [total[metric]]));
		totals[metric] =
			available.length || empty ? available.reduce((sum, value) => sum + value, 0) : null;
	}
	const red = perRepo.flatMap((total) =>
		total.red_default_branch === null ? [] : [total.red_default_branch],
	);
	totals.red_default_branch = red.length || empty ? red.flat() : null;
	return { totals, totals_partial: missing.length > 0, totals_coverage: { missing } };
}

export function activityReadContentVersion(publication: string) {
	return contentVersion("activity", { input: publication, derivation: "metric-totals-v1" });
}
