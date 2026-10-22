export function dailyReport(
	date = "2026-10-22",
	headline = "Daily delivery review",
	generatedAt = `${date}T08:00:00Z`,
) {
	return {
		id: `github-daily-${date}`,
		account_id: "a",
		type: "github-daily" as const,
		status: "completed" as const,
		repository: null,
		source_version: null,
		revision: 1,
		created_at: generatedAt,
		updated_at: generatedAt,
		payload: {
			date,
			window: { since: `${date}T00:00:00+08:00`, until: `${date}T08:00:00+08:00` },
			refreshRunId: "daily-run",
			headline,
			sections: [
				{
					title: "Delivery",
					markdown: "Review changes. <script>alert(1)</script>",
					items: [
						{
							repo: "owner/app",
							kind: "ci",
							url: "https://github.com/owner/app/actions/runs/1",
							severity: "review",
						},
					],
				},
			],
			comparisons: { vsYesterday: "One fewer failure", vs7d: "Delivery remains stable" },
			links: { xray: "https://xray.example/daily" },
			generatedAt,
			sources: [
				{
					resource: "account:ci",
					version: "v1",
					fetchedAt: generatedAt,
					complete: true,
					stale: false,
				},
			],
		},
	};
}
