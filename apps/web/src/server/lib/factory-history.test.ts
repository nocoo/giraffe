import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { emptyDay, factoryWindow } from "../../lib/factory";
import { retainContributionDays, retainRepositoryDays } from "./factory-history";

const now = "2026-10-24T05:00:00.000Z";
const window = factoryWindow(now, 30);

it("uses older saved day evidence even when the old display window was narrowed", () => {
	const repo = factoryFixture().repos[0];
	if (!repo) throw new Error("fixture");
	repo.observation = { version: "new", source: "run", window, refreshedAt: now };
	const previous = structuredClone(repo);
	previous.metrics.days = { "2026-08-01": { ...emptyDay(), commits: 2 } };
	retainRepositoryDays(repo, previous, window);
	expect(repo.observation.window.since).toBe("2026-08-01T00:00:00.000Z");
	expect(repo.metrics.commits).toBe(2);
});

it("never carries daily history from a different repository identity", () => {
	const repo = factoryFixture().repos[0];
	if (!repo) throw new Error("fixture");
	repo.observation = { version: "new", source: "run", window, refreshedAt: now };
	const previous = structuredClone(repo);
	previous.id = "replaced";
	previous.observation = { ...repo.observation, window: factoryWindow(now, 90) };
	previous.metrics.days = { "2026-08-01": { ...emptyDay(), commits: 2 } };
	retainRepositoryDays(repo, previous, window);
	expect(repo.observation.window).toEqual(window);
	expect(repo.metrics.commits).toBe(0);
});

it("only carries dated totals, preserving fresh non-daily measurements and removing stale input buckets", () => {
	const repo = factoryFixture().repos[0];
	if (!repo) throw new Error("fixture");
	repo.observation = { version: "new", source: "run", window, refreshedAt: now };
	repo.metrics.days = {
		"2026-08-01": { ...emptyDay(), commits: 99 },
		"2026-10-24": { ...emptyDay(), commits: 3 },
	};
	repo.metrics.commits = 102;
	repo.metrics.authors = { fresh: 3 };
	repo.metrics.cycleHours = [12];
	repo.metrics.agedIssues = 4;
	const previous = structuredClone(repo);
	previous.observation = { ...repo.observation, window: factoryWindow(now, 90) };
	previous.metrics.days = { "2026-08-01": { ...emptyDay(), commits: 2 } };
	retainRepositoryDays(repo, previous, window);
	expect(repo.metrics).toMatchObject({
		commits: 5,
		authors: { fresh: 3 },
		cycleHours: [12],
		agedIssues: 4,
	});
	expect(repo.metrics.days["2026-08-01"]?.commits).toBe(2);
	expect(previous.metrics.days["2026-08-01"]?.commits).toBe(2);
	delete repo.observation;
	const before = structuredClone(repo);
	retainRepositoryDays(repo, previous, window);
	expect(repo).toEqual(before);
});

it.each([0, 2, null])(
	"keeps restricted contribution totals honest with retained per-day count %s",
	(restricted) => {
		const base = factoryFixture();
		const old = {
			date: "2026-08-01",
			count: 7,
			observedAt: "old",
			breakdown: "mismatch" as const,
			...(restricted === null
				? {}
				: {
						types: {
							commits: 5,
							issues: 0,
							pullRequests: 0,
							pullRequestReviews: 0,
							repositories: 0,
							restricted,
						},
					}),
		};
		base.window = factoryWindow(now, 90);
		base.contribution = { days: [old], total: 7, restricted: 2, fetchedAt: "old" };
		const fresh = {
			days: [{ date: "2026-10-24", count: 3, breakdown: "complete" as const }],
			total: 3,
			restricted: 1,
			fetchedAt: now,
			typesStatus: "complete" as const,
		};
		const result = retainContributionDays(fresh, base, window);
		expect(result.window).toEqual(base.window);
		expect(result.contribution).toMatchObject({
			total: 10,
			restricted: restricted === null ? null : restricted + 1,
			typesStatus: "partial",
			days: [old, fresh.days[0]],
		});
		expect(fresh.total).toBe(3);
	},
);

it("does not invent old contributions on first publish and excludes an exact midnight endpoint", () => {
	const fresh = {
		days: [
			{ date: "2026-10-23", count: 3 },
			{ date: "2026-10-24", count: 0 },
		],
		total: 3,
		restricted: 0,
		fetchedAt: now,
	};
	const midnight = factoryWindow("2026-10-24T00:00:00.000Z", 30);
	const result = retainContributionDays(fresh, null, midnight);
	expect(result.window).toEqual(midnight);
	expect(result.contribution.days).toEqual([fresh.days[0]]);
	expect(result.contribution.total).toBe(3);
});
