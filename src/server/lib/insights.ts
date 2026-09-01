export type InsightAlert = {
	name_with_owner: string;
	source: string;
	severity: string;
	summary: string;
	url: string;
};

export type RepoRow = {
	name_with_owner: string;
	open_issue_count: number;
	pushed_at: string | null;
};

export type Insight = {
	name_with_owner: string;
	open_issue_count: number;
	days_since_push: number;
	health: "strong" | "watch" | "risky";
	alerts: InsightAlert[];
	opportunities: Array<"stale_push" | "many_issues" | "open_alerts">;
};

function daysSince(fetchedAt: string, pushedAt: string | null): number {
	if (!pushedAt) {
		return 9999;
	}
	const ms = Date.parse(fetchedAt) - Date.parse(pushedAt);
	if (!Number.isFinite(ms) || ms < 0) {
		return 9999;
	}
	return Math.floor(ms / 86_400_000);
}

export function buildInsights(
	repos: RepoRow[],
	alerts: InsightAlert[],
	fetchedAt: string,
): { fetched_at: string; truncated: boolean; insights: Insight[] } {
	const byRepo = new Map<string, InsightAlert[]>();
	for (const alert of alerts) {
		const list = byRepo.get(alert.name_with_owner) ?? [];
		list.push(alert);
		byRepo.set(alert.name_with_owner, list);
	}
	const insights = repos.map((repo) => {
		const repoAlerts = byRepo.get(repo.name_with_owner) ?? [];
		const days = daysSince(fetchedAt, repo.pushed_at);
		const high = repoAlerts.some((a) => a.severity === "high" || a.severity === "critical");
		let health: Insight["health"] = "strong";
		if (days >= 90 || high) {
			health = "risky";
		} else if (days >= 30 || repo.open_issue_count >= 20 || repoAlerts.length > 0) {
			health = "watch";
		}
		const opportunities: Insight["opportunities"] = [];
		if (days >= 90) {
			opportunities.push("stale_push");
		}
		if (repo.open_issue_count >= 20) {
			opportunities.push("many_issues");
		}
		if (repoAlerts.length > 0) {
			opportunities.push("open_alerts");
		}
		return {
			name_with_owner: repo.name_with_owner,
			open_issue_count: repo.open_issue_count,
			days_since_push: days,
			health,
			alerts: repoAlerts,
			opportunities,
		};
	});
	return { fetched_at: fetchedAt, truncated: false, insights };
}
