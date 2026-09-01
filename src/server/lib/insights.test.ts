import { describe, expect, it } from "vitest";
import { buildInsights } from "./insights";

describe("buildInsights", () => {
	const fetched = "2026-09-01T00:00:00.000Z";

	it("classifies strong watch and risky", () => {
		const result = buildInsights(
			[
				{ name_with_owner: "a/s", open_issue_count: 1, pushed_at: "2026-08-20T00:00:00.000Z" },
				{ name_with_owner: "a/w", open_issue_count: 21, pushed_at: "2026-07-20T00:00:00.000Z" },
				{ name_with_owner: "a/r", open_issue_count: 0, pushed_at: "2026-01-01T00:00:00.000Z" },
			],
			[{ name_with_owner: "a/w", source: "dependabot", severity: "low", summary: "x", url: "" }],
			fetched,
		);
		expect(result.insights[0]?.health).toBe("strong");
		expect(result.insights[1]?.health).toBe("watch");
		expect(result.insights[1]?.opportunities).toContain("many_issues");
		expect(result.insights[1]?.opportunities).toContain("open_alerts");
		expect(result.insights[2]?.health).toBe("risky");
		expect(result.insights[2]?.opportunities).toContain("stale_push");
	});

	it("treats missing pushed_at as ancient", () => {
		const result = buildInsights(
			[{ name_with_owner: "a/x", open_issue_count: 0, pushed_at: null }],
			[
				{
					name_with_owner: "a/x",
					source: "dependabot",
					severity: "critical",
					summary: "",
					url: "",
				},
			],
			fetched,
		);
		expect(result.insights[0]?.days_since_push).toBe(9999);
		expect(result.insights[0]?.health).toBe("risky");
	});

	it("treats future pushed_at as ancient", () => {
		const result = buildInsights(
			[{ name_with_owner: "a/x", open_issue_count: 0, pushed_at: "2099-01-01T00:00:00.000Z" }],
			[],
			"2026-09-01T00:00:00.000Z",
		);
		expect(result.insights[0]?.days_since_push).toBe(9999);
	});
});
