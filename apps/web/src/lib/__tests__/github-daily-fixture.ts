import type { GithubDaily } from "../github-daily";

export const dailyAt = "2026-10-22T00:00:00.000Z";
export function dailyPayload(date = "2026-10-22", generatedAt = dailyAt): GithubDaily {
	return {
		date,
		window: { since: "2026-10-21T00:00:00Z", until: "2026-10-22T00:00:00Z" },
		refreshRunId: "retained-run",
		headline: "Daily report",
		sections: [
			{
				title: "Changes",
				markdown: "<script>escaped text</script>",
				items: [
					{
						repo: "owner/app",
						kind: "issue",
						url: "https://github.com/owner/app/issues/1",
						severity: "producer-label",
					},
				],
			},
		],
		comparisons: { vsYesterday: "", vs7d: "No comparison" },
		links: { xray: "https://xray.example/articles/day" },
		generatedAt,
		sources: [
			{
				resource: "account:a:repos",
				version: "v1",
				fetchedAt: dailyAt,
				complete: true,
				stale: false,
			},
		],
	};
}
export function dailyResource(date = "2026-10-22", generatedAt = dailyAt) {
	return {
		id: `github-daily-${date}`,
		account_id: "a",
		type: "github-daily",
		repository: null,
		status: "completed",
		source_version: null,
		payload: dailyPayload(date, generatedAt),
		revision: 1,
		created_at: dailyAt,
		updated_at: dailyAt,
	};
}
