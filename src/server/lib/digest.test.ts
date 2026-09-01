import { describe, expect, it } from "vitest";
import { buildDigest, yesterday } from "./digest";

describe("buildDigest", () => {
	const fetched = "2026-09-01T12:00:00.000Z";
	const today = {
		stars: 10,
		forks: 2,
		open_issues: 3,
		repos: 2,
		by_repo: [
			{ name_with_owner: "a/one", stars: 8, forks: 1, open_issues: 1 },
			{ name_with_owner: "a/new", stars: 2, forks: 1, open_issues: 2 },
		],
	};

	it("returns null deltas when yesterday is missing", () => {
		const digest = buildDigest(today, null, fetched);
		expect(digest.baseline_missing).toBe(true);
		expect(digest.stars_delta).toBeNull();
		expect(digest.repos[0]?.stars_delta).toBeNull();
		expect(yesterday("2026-09-01")).toBe("2026-08-31");
	});

	it("subtracts adjacent-day counts and nulls unknown repos", () => {
		const previous = {
			stars: 7,
			forks: 1,
			open_issues: 4,
			repos: 1,
			by_repo: [{ name_with_owner: "a/one", stars: 7, forks: 1, open_issues: 4 }],
		};
		const digest = buildDigest(today, previous, fetched);
		expect(digest.baseline_missing).toBe(false);
		expect(digest.stars_delta).toBe(3);
		expect(digest.open_issues_delta).toBe(-1);
		expect(digest.repos[0]?.stars_delta).toBe(1);
		expect(digest.repos[1]?.stars_delta).toBeNull();
	});
});
