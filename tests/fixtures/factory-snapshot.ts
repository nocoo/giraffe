import { emptyMetrics } from "../../src/lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryRepo,
	type FactorySnapshot,
} from "../../src/lib/factory-types";
export function factoryFixture(): FactorySnapshot {
	const now = "2026-09-15T22:00:00.000Z";
	const repo: FactoryRepo = {
		id: "R_1",
		name: "nocoo/app",
		url: "https://github.com/nocoo/app",
		description: "Example",
		private: true,
		diskKiB: 1024,
		pushedAt: now,
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 100 }],
		languageBytes: 100,
		languagesComplete: true,
		topics: ["cli"],
		branch: "main",
		head: "abc",
		totalCommits: 3,
		openIssues: 1,
		closedIssues: 2,
		openPrs: 1,
		closedPrs: 2,
		mergedPrs: 3,
		totalReleases: 1,
		coverage: Object.fromEntries(
			FACTORY_STREAMS.map((s) => [
				s,
				{ status: "pending", pages: 0, fetchedAt: null, source: "", reason: null, observed: 0 },
			]),
		) as FactoryRepo["coverage"],
		metrics: emptyMetrics(),
		dependencies: [],
	};
	return {
		schema: 1,
		account_id: "a".repeat(21),
		owner: "nocoo",
		runId: now,
		revision: 0,
		leaseUntil: null,
		startedAt: now,
		fetched_at: now,
		window: { since: "2026-06-18T00:00:00.000Z", until: now },
		status: "collecting",
		inventory: { total: 1, scanned: 1, complete: true, after: null, pages: 1, excluded: [] },
		repos: [repo],
		cursor: { repo: 0, stream: 0 },
		requests: 1,
		rate: null,
		contribution: null,
		contributionStatus: "pending",
	};
}
