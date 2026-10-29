import { factoryFixture } from "../fixtures/factory-snapshot";
import { activityAt, activityFixture, activityPr, activityRun } from "./activity-fixtures";
import { createUiFixtures, projectFactoryFixture } from "./ui-fixtures";

export function refreshReviewRun() {
	return {
		id: "refresh-review-current",
		accountId: "ui-account",
		params: {
			since: "2026-10-22",
			until: "2026-10-22",
			timezone: "Asia/Shanghai",
			dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
			force: false,
		},
		trigger: "manual",
		status: "running",
		phase: "repos",
		repos: ["octocat/hello-world", "octocat/basalt", "octocat/field-notes"],
		completedRepos: 1,
		requests: 12,
		requestBreakdown: {
			total: 12,
			graphql: 6,
			rest: 6,
			a: { graphql: 4, rest: 1 },
			b: { graphql: 2, rest: 5 },
		},
		partialReasons: [{ repo: "octocat/hello-world", codes: ["alerts:permission_denied"] }],
		partial: true,
		cancelRequested: false,
		errorCode: null,
		createdAt: "2026-10-23T01:00:00.000Z",
		updatedAt: "2026-10-23T01:01:20.000Z",
		finishedAt: null,
		timings: {
			queuedAt: "2026-10-23T01:00:00.000Z",
			a: {
				startedAt: "2026-10-23T01:00:01.000Z",
				finishedAt: "2026-10-23T01:00:15.000Z",
				attempts: 1,
				reused: false,
			},
			repos: [
				{
					repo: "octocat/hello-world",
					startedAt: "2026-10-23T01:00:15.000Z",
					finishedAt: "2026-10-23T01:00:55.000Z",
					attempts: 1,
				},
				{
					repo: "octocat/basalt",
					startedAt: "2026-10-23T01:00:55.000Z",
					finishedAt: null,
					attempts: 1,
				},
			],
		},
	};
}

export function uiRefreshReviewFixtures(): Record<string, unknown> {
	const activity = activityFixture();
	const activityRepo = activity.repos[0];
	if (!activityRepo) throw new Error("Missing activity fixture");
	activityRepo.prs.merged = [
		activityPr(),
		{ ...activityPr("82"), title: "Align compact controls with Basalt", author: "reviewer" },
	];
	activityRepo.ci_runs = [activityRun()];
	activityRepo.deploy.runs = [activityRun()];
	activityRepo.commits = {
		default: 2,
		other: 0,
		items: ["Restore clear refresh progress", "Keep missing observations visible"].map(
			(message, index) => ({
				sha: `abc123${index}`,
				author: "octocat",
				message,
				at: activityAt,
				url: `https://github.com/octocat/hello-world/commit/abc123${index}`,
				branch: "main",
				is_default_branch: true,
			}),
		),
	};
	activity.totals.merged_prs = 2;
	activity.totals.ci_runs = 1;
	const factory = factoryFixture();
	factory.account_id = "ui-account";
	factory.owner = "octocat";
	factory.status = "complete";
	factory.fetched_at = "2026-10-23T01:00:00.000Z";
	factory.window = {
		since: "2026-07-24T16:00:00.000Z",
		until: "2026-10-22T16:00:00.000Z",
		timezone: "Asia/Shanghai",
	};
	const base = factory.repos[0];
	if (!base) throw new Error("Missing factory fixture");
	factory.repos = ["hello-world", "basalt", "field-notes"].map((name, index) => {
		const repo = structuredClone(base);
		repo.id = `review-repo-${index}`;
		repo.name = `octocat/${name}`;
		repo.url = `https://github.com/${repo.name}`;
		repo.description =
			[
				"Personal developer workspace",
				"Shared design system and charts",
				"Notes on software and design",
			][index] ?? null;
		repo.language = index === 2 ? "MDX" : "TypeScript";
		repo.languageBytes = 140000 * (index + 1);
		repo.pushedAt = "2026-10-22T08:00:00.000Z";
		repo.observation = {
			version: "review-observation",
			window: factory.window,
			refreshedAt: factory.fetched_at,
			source: "run",
		};
		for (const coverage of Object.values(repo.coverage)) {
			coverage.status = "complete";
			coverage.fetchedAt = factory.fetched_at;
			coverage.completeWindows = [
				{
					since: "2026-10-19T16:00:00.000Z",
					until: "2026-10-22T16:00:00.000Z",
					timezone: "Asia/Shanghai",
				},
			];
		}
		repo.coverage.dependencies.status = "unavailable";
		repo.coverage.dependencies.reason = "Dependency observations are not collected";
		for (const date of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
			repo.metrics.days[date] = {
				commits: 3 + index,
				issueOpened: 2,
				issueClosed: 1,
				prOpened: 2,
				prMerged: 1,
				prClosed: 0,
				ciSuccess: 5,
				ciFailure: index,
				releases: 1,
			};
		}
		repo.metrics.commits = (3 + index) * 3;
		repo.metrics.prMerged = 3;
		repo.metrics.releases = 3;
		return repo;
	});
	factory.inventory.total = factory.inventory.scanned = factory.repos.length;
	const current = refreshReviewRun();
	const history = {
		...current,
		id: "refresh-review-history",
		status: "partial",
		phase: "done",
		completedRepos: 3,
		createdAt: "2026-10-22T01:00:00.000Z",
		updatedAt: "2026-10-22T01:02:10.000Z",
		finishedAt: "2026-10-22T01:02:10.000Z",
		timings: undefined,
	};
	return {
		...createUiFixtures(),
		"/api/activity": activity,
		"/api/factory": projectFactoryFixture(factory),
		"/api/refresh-runs": { items: [current, history], collectionAvailable: true },
		"/api/refresh-runs/latest": history,
		[`/api/refresh-runs/${current.id}`]: current,
		[`/api/refresh-runs/${history.id}`]: history,
		"/api/tokens": {
			account_id: "ui-account",
			items: [
				{
					id: "review-token",
					account_id: "ui-account",
					label: "Daily digest bot",
					scopes: ["observations:read"],
					creator: "demo@example.test",
					created_at: "2026-10-01T00:00:00.000Z",
					expires_at: "2026-12-01T00:00:00.000Z",
					last_used_at: null,
					revoked_at: null,
				},
			],
		},
	};
}
