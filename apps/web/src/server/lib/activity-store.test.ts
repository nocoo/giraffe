import { expect, it } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { ActivityCommit, ActivitySnapshot } from "../../lib/activity-types";
import { makeRun } from "../../lib/factory-run";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import type { Env } from "../env";
import { createApp } from "../index";
import { activityEtag } from "../routes/activity";
import { activityRepo } from "./activity";
import {
	activityPublicationWrites,
	freezeActivityRepo,
	packActivity,
	readActivity,
} from "./activity-store";
import { activityReadContentVersion } from "./activity-totals";
import { createDb } from "./db/d1";
import { claimRun, controlRun, saveRun, startRun } from "./db/factory-runs";
import { mapFactoryEvents, mapFactoryRepo } from "./factory-map";
import { currentRepo, repositoryWrites } from "./factory-publish";
import { readSources } from "./machine-sources";

it("derives totals for existing frozen publications without writes and binds polling validators", async () => {
	const fixture = await setup();
	const repo = activityRepo(fixture.repo, new Map(), snapshotFor([]).window, null, null);
	repo.ci_runs = [];
	repo.coverage.actions = { status: "complete", truncated: false, reason: null };
	repo.coverage.default_branch = { status: "complete", truncated: false, reason: null };
	repo.coverage.run = { status: "partial", truncated: false, reason: "security unavailable" };
	const header = { ...snapshotFor([]), membership: [repo.repo] };
	await fixture.db.prepare("UPDATE factory_runs SET status='partial' WHERE id='r2'").run();
	await fixture.db.prepare("UPDATE accounts SET is_active=1").run();
	await fixture.db
		.prepare(
			"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('account_123','r2',?,?,?,'saved')",
		)
		.bind(now, now, JSON.stringify(header))
		.run();
	await fixture.db
		.prepare("INSERT INTO activity_pages VALUES('account_123','r2',0,?)")
		.bind(JSON.stringify([repo]))
		.run();
	const before = await fixture.db.prepare("SELECT * FROM activity_publications").all();
	const pagesBefore = await fixture.db.prepare("SELECT * FROM activity_pages").all();
	const app = createApp();
	const env = {
		DB: fixture.raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env;
	const response = await app.request("http://localhost/api/activity", {}, env);
	expect(response.status).toBe(200);
	const data = await response.json();
	expect(data).toMatchObject({
		runId: "r2",
		totals: { ci_runs: 0, merged_prs: null },
		totals_partial: true,
	});
	const tag = response.headers.get("ETag");
	expect(tag).toBeTruthy();
	const oldApp = new Hono();
	oldApp.get("/api/activity", activityEtag, (context) =>
		context.json({ ...header, repos: [repo] }),
	);
	const oldResponse = await oldApp.request("http://localhost/api/activity");
	expect(oldResponse.headers.get("ETag")).not.toBe(tag);
	expect(
		(
			await app.request(
				"http://localhost/api/activity",
				{ headers: { "If-None-Match": tag ?? "" } },
				env,
			)
		).status,
	).toBe(304);
	expect(await readActivity(fixture.db, "account_123", { run: ["r2"] })).toEqual(data);
	const source = (await readSources(fixture.db, "account_123", {})).sources.find(
		(source) => source.resource === "account:activity",
	);
	expect(source?.contentVersion).toBe(await activityReadContentVersion("saved"));
	expect(await fixture.db.prepare("SELECT * FROM activity_publications").all()).toEqual(before);
	expect(await fixture.db.prepare("SELECT * FROM activity_pages").all()).toEqual(pagesBefore);
});

const now = "2026-10-22T20:00:00.000Z";
async function seedLanded(
	fixture: Awaited<ReturnType<typeof setup>>,
	items: ActivityCommit[] = [],
) {
	const { db, lease, repo } = fixture;
	const metadata = lease.run.steps.find((step) => step.kind === "metadata");
	if (!metadata) throw new Error("Missing metadata fixture");
	metadata.status = "success";
	metadata.sourceHead = items[0]?.sha ?? null;
	await db
		.prepare("INSERT INTO activity_commit_heads(account_id,repo_id,head) VALUES(?,?,?)")
		.bind(lease.run.account_id, repo.id, metadata.sourceHead)
		.run();
	for (const item of items) {
		const payload = {
			...item,
			observation: {
				runId: lease.run.id,
				window: lease.run.activityWindow,
				at: now,
				bootstrap: true,
			},
		};
		await db
			.prepare(
				"INSERT INTO activity_commit_ledger(account_id,repo_id,sha,first_run_id,observed_at,window_since,window_until,payload) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(
				lease.run.account_id,
				repo.id,
				item.sha,
				lease.run.id,
				now,
				lease.run.activityWindow?.since,
				now,
				JSON.stringify(payload),
			)
			.run();
	}
}
async function setup(name = rawRepo.nameWithOwner) {
	const raw = sqliteFixture();
	const db = createDb(raw, undefined, 10_000);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account_123','nocoo','fake','fake',?,?)",
		)
		.bind(now, now)
		.run();
	const repo = mapFactoryRepo({ ...rawRepo, nameWithOwner: name });
	const run = makeRun(
		"r2",
		"account_123",
		"nocoo",
		"key",
		"refresh",
		[repo],
		now,
		[],
		[repo.name],
		{ scope: "all" },
		"quick",
	);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture");
	for (const stream of FACTORY_STREAMS)
		await db
			.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
			.bind(
				run.id,
				repo.name,
				stream,
				JSON.stringify({
					runId: run.id,
					items: [],
					next: null,
					ranges: [],
					coverage: { ...repo.coverage[stream], status: "complete" },
				}),
			)
			.run();
	return { raw, db, lease, repo };
}
async function seedFrozenSnapshot(
	db: Awaited<ReturnType<typeof setup>>["db"],
	lease: Awaited<ReturnType<typeof setup>>["lease"],
	repo: Awaited<ReturnType<typeof setup>>["repo"],
) {
	for (const step of lease.run.steps) if (step.status === "pending") step.status = "success";
	await db.batch([await freezeActivityRepo(db, lease, now, repo, extra())]);
}
it("R4 publication and pages are immutable, fenced and readable without GitHub or SQL JSON rebuilding", async () => {
	const { raw, db, lease, repo } = await setup();
	await seedFrozenSnapshot(db, lease, repo);
	const writes = await activityPublicationWrites(db, lease, now, [repo]);
	lease.run.status = "completed";
	expect(await saveRun(db, lease, writes, now)).toBe(true);
	const readDb = createDb(raw);
	const data = await readActivity(readDb, "account_123", {});
	expect(data).toMatchObject({
		runId: "r2",
		previousRunId: null,
		fetchedAt: now,
		window: { first: true, gap: true },
		repos: [{ repo: "nocoo/app" }],
	});
	expect(readDb.statements).toBe(3);
	expect(
		await readActivity(createDb(raw), "account_123", { run: ["r2"], repository: ["NOCOO/App"] }),
	).toMatchObject({ repos: [{ repo: "nocoo/app" }], contributions: null });
	await expect(
		readActivity(createDb(raw), "account_123", { run: ["unknown"] }),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		readActivity(createDb(raw), "account_123", { run: ["r2", "r2"] }),
	).rejects.toMatchObject({ status: 400 });
});
it("R4 revoked leases cannot leave activity pages and unpublished runs never return partial data", async () => {
	const { raw, db, lease, repo } = await setup();
	await expect(readActivity(createDb(raw), "account_123", { run: ["r2"] })).rejects.toMatchObject({
		status: 409,
	});
	await seedFrozenSnapshot(db, lease, repo);
	const writes = await activityPublicationWrites(db, lease, now, [repo]);
	await controlRun(createDb(raw), "account_123", "r2", "pause", now);
	expect(await saveRun(db, lease, writes, now)).toBe(false);
	expect(
		(
			await createDb(raw)
				.prepare("SELECT COUNT(*) AS n FROM activity_publications")
				.first<{ n: number }>()
		)?.n,
	).toBe(0);
});
it.each([
	["limited", "dependency_parse_unsupported", "success", false, false],
	["limited", "coverage_limited", "success", true, true],
	["failed", "dependency_parse_unsupported", "success", true, false],
	["unavailable", "dependency_parse_unsupported", "success", true, false],
	["limited", "dependency_parse_unsupported", "limited", true, true],
	["limited", "dependency_parse_unsupported", "failed", true, false],
	["limited", "dependency_parse_unsupported", "unavailable", true, false],
] as const)(
	"publishes activity run coverage for dependency %s/%s and actions %s",
	async (status, error, otherStatus, partial, truncated) => {
		const { raw, db, lease, repo } = await setup();
		for (const step of lease.run.steps) step.status = "success";
		const dependency = lease.run.steps.find((step) => step.kind === "dependencies");
		const actions = lease.run.steps.find((step) => step.kind === "actions");
		if (!dependency || !actions) throw new Error("Missing source steps");
		Object.assign(dependency, { status, error });
		actions.status = otherStatus;
		const streams = new Map(
			FACTORY_STREAMS.map((stream) => [
				stream,
				{
					runId: lease.run.id,
					items: [],
					next: null,
					ranges: [],
					coverage: { ...repo.coverage[stream], status: "complete" as const },
				},
			]),
		);
		const activity = activityRepo(
			repo,
			streams,
			snapshotFor([]).window,
			extra(),
			{
				features: { dependabot: { status: "available" }, code_scanning: { status: "available" } },
				dependabot_open: 0,
				code_scanning_open: 0,
			},
			{ items: [], deferred: [], coverage: { status: "complete", truncated: false, reason: null } },
		);
		await db
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,'activity-snapshot',?)",
			)
			.bind(lease.run.id, repo.name, JSON.stringify(activity))
			.run();
		const writes = await activityPublicationWrites(db, lease, now, [repo]);
		lease.run.status = partial ? "partial" : "completed";
		expect(await saveRun(db, lease, writes, now)).toBe(true);
		const data = await readActivity(createDb(raw), lease.run.account_id, {});
		expect(data.truncated).toBe(truncated);
		expect(data.coverage.repos).toMatchObject({
			status: partial ? "partial" : "complete",
			truncated,
		});
		if (partial)
			expect(data.repos[0]?.coverage.run).toMatchObject({ status: "partial", truncated });
		else expect(data.repos[0]?.coverage.run).toBeUndefined();
	},
);
it("refuses activity publication when no frozen activity-snapshot rows exist", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account_123','nocoo','fake','fake',?,?)",
		)
		.bind(now, now)
		.run();
	const repo = mapFactoryRepo(rawRepo);
	const run = makeRun(
		"r2",
		"account_123",
		"nocoo",
		"key",
		"refresh",
		[repo],
		now,
		[],
		[repo.name],
		{ scope: "all" },
		"quick",
	);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, now);
	if (!lease) throw new Error("fixture");
	for (const stream of FACTORY_STREAMS)
		await db
			.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
			.bind(
				run.id,
				repo.name,
				stream,
				JSON.stringify({
					runId: run.id,
					items: [],
					next: null,
					ranges: [],
					coverage: { ...repo.coverage[stream], status: "complete" },
				}),
			)
			.run();
	const activity = lease.run.steps.find((step) => step.kind === "activity");
	if (activity) Object.assign(activity, { status: "limited", error: "factory_capacity" });
	const goodHeader = { ...snapshotFor([]), membership: [repo.name], runId: "r1" };
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('r1','account_123','r1','completed','{}',?,?,?)",
		)
		.bind(now, now, now)
		.run();
	await db
		.prepare(
			"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('account_123','r1',?,?,?,'saved')",
		)
		.bind(now, now, JSON.stringify(goodHeader))
		.run();
	await db
		.prepare("INSERT INTO activity_pages VALUES('account_123','r1',0,?)")
		.bind(JSON.stringify([activityRepo(repo, new Map(), snapshotFor([]).window, null, null)]))
		.run();
	expect(await activityPublicationWrites(db, lease, now, [repo])).toEqual([]);
	expect(
		(
			await db
				.prepare("SELECT COUNT(*) AS n FROM activity_publications WHERE run_id='r2'")
				.first<{ n: number }>()
		)?.n,
	).toBe(0);
	const latest = await readActivity(createDb(raw), "account_123", {});
	expect(latest.runId).toBe("r1");
	await expect(readActivity(createDb(raw), "account_123", { run: ["r2"] })).rejects.toMatchObject({
		status: 409,
	});
});
it.each(["failed", "unavailable", "limited"] as const)(
	"B2 publishes partial runs with %s repository evidence, source discovery and chaining",
	async (status) => {
		const { raw, db, lease, repo } = await setup();
		const step = lease.run.steps.find((step) => step.repo === repo.name);
		if (!step) throw new Error("fixture");
		step.status = status;
		await seedFrozenSnapshot(db, lease, repo);
		const writes = await activityPublicationWrites(db, lease, now, [repo]);
		expect(writes.length).toBeGreaterThan(0);
		lease.run.status = "partial";
		lease.run.finishedAt = now;
		expect(await saveRun(db, lease, writes, now)).toBe(true);
		const data = await readActivity(createDb(raw), "account_123", {});
		expect(data).toMatchObject({
			runId: "r2",
			coverage: { repos: { status: "partial" } },
			repos: [{ coverage: { run: { status: "partial" } }, ci_runs: [] }],
			totals: { ci_runs: 0, merged_prs: 0, issues_opened: 0, releases: 0 },
		});
		expect(await readActivity(createDb(raw), "account_123", { run: ["r2"] })).toEqual(data);
		const sources = await readSources(createDb(raw), "account_123", {});
		expect(sources.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ resource: "account:activity", version: "r2" }),
			]),
		);
		const next = makeRun(
			"r3",
			"account_123",
			"nocoo",
			"next",
			"refresh",
			[repo],
			"2026-10-23T20:00:00.000Z",
			[],
			[repo.name],
			{ scope: "all" },
			"quick",
		);
		const admitted = await startRun(createDb(raw), next);
		expect(admitted.previousActivityRunId).toBe("r2");
		expect(admitted.activityWindow).toEqual({
			since: now,
			until: next.window.until,
			first: false,
			gap: false,
		});
	},
);
it.each(["failed", "cancelled", "paused"] as const)(
	"B2 never exposes activity from a %s run even if publication rows exist",
	async (status) => {
		const { raw, db, lease, repo } = await setup();
		await seedFrozenSnapshot(db, lease, repo);
		const writes = await activityPublicationWrites(db, lease, now, [repo]);
		await db.batch(writes);
		await db.prepare("UPDATE factory_runs SET status=? WHERE id='r2'").bind(status).run();
		await expect(readActivity(createDb(raw), "account_123", {})).rejects.toMatchObject({
			status: 409,
		});
		await expect(readActivity(createDb(raw), "account_123", { run: ["r2"] })).rejects.toMatchObject(
			{ status: 409 },
		);
		lease.run.status = status;
		expect(await activityPublicationWrites(db, lease, now, [repo])).toEqual([]);
	},
);
it("R4 every UTF-8 page stays within 1.5 MB even before shared page-cap repair", () => {
	const repo = activityRepo(
		mapFactoryRepo(rawRepo),
		new Map(),
		{ since: "2026-10-21T20:00:00.000Z", until: now, gap: false, first: false },
		null,
		null,
	);
	repo.releases = Array.from({ length: 4000 }, (_, id) => ({
		id: String(id),
		title: "界".repeat(200),
		url: "",
		at: now,
		createdAt: now,
		closedAt: null,
		mergedAt: null,
		author: null,
		state: "published",
	}));
	const snapshot: ActivitySnapshot = {
		account_id: "account_123",
		window: { since: "2026-10-21T20:00:00.000Z", until: now, gap: false, first: false },
		runId: "r2",
		previousRunId: null,
		fetchedAt: now,
		repos: [repo],
		totals: {
			ci_runs: null,
			merged_prs: null,
			dependency_prs: null,
			other_prs: null,
			issues_opened: null,
			issues_closed: null,
			releases: 4000,
			red_default_branch: null,
		},
		contributions: null,
		coverage: {},
		truncated: false,
	};
	const packed = packActivity(snapshot);
	expect(packed.header.truncated).toBe(true);
	for (const page of packed.pages)
		expect(new TextEncoder().encode(page).length).toBeLessThanOrEqual(1_500_000);
	expect(packed.header.totals.releases).toBeNull();
});

function snapshotFor(repos: ActivitySnapshot["repos"]): ActivitySnapshot {
	return {
		account_id: "account_123",
		window: { since: "2026-10-21T20:00:00.000Z", until: now, gap: false, first: false },
		runId: "r2",
		previousRunId: null,
		fetchedAt: now,
		repos,
		totals: {
			ci_runs: null,
			merged_prs: null,
			dependency_prs: null,
			other_prs: null,
			issues_opened: null,
			issues_closed: null,
			releases: null,
			red_default_branch: null,
		},
		contributions: null,
		coverage: {},
		truncated: false,
	};
}
function extra(): import("./activity-collect").ActivitySupplement {
	return {
		commits: [],
		tags: [],
		last_success_at: null,
		coverage: {
			other_commits: { status: "complete", truncated: false, reason: null },
			tags: { status: "complete", truncated: false, reason: null },
			deploy: { status: "complete", truncated: false, reason: null },
		},
		phase: "done",
		after: null,
		tagAfter: null,
		pending: [],
		deployNext: null,
		pages: 1,
	};
}
it("R4 freezes only accepted current-run resource evidence with fresh feature-level security", async () => {
	const { freezeActivityRepo } = await import("./activity-store");
	const s = await setup();
	await seedLanded(s);
	s.repo.observation = {
		version: "r2",
		window: s.lease.run.window,
		refreshedAt: now,
		source: "run",
	};
	const step = s.lease.run.steps.find((step) => step.resource === "repo:nocoo/app:security");
	if (!step) throw new Error("fixture");
	step.status = "success";
	step.startedAt = now;
	step.finishedAt = now;
	await s.db
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('r2','','site:repo:nocoo/app:security',?)",
		)
		.bind(
			JSON.stringify({
				fetched_at: now,
				features: { dependabot: { status: "available" }, code_scanning: { status: "available" } },
				dependabot_open: 0,
				code_scanning_open: 1,
			}),
		)
		.run();
	await s.db.batch([await freezeActivityRepo(s.db, s.lease, now, s.repo, extra())]);
	const writes = await activityPublicationWrites(s.db, s.lease, now, [s.repo]);
	s.lease.run.status = "completed";
	await saveRun(s.db, s.lease, writes, now);
	const data = await readActivity(createDb(s.raw), "account_123", {});
	expect(data.repos[0]).toMatchObject({
		snapshot: {
			open_prs: [],
			open_issues: { dependency: [], security: [], other: [] },
			dependabot: 0,
			code_scanning: 1,
		},
		commits: { default: 0, other: 0 },
		coverage: { actions: { status: "complete" } },
	});
});
it("R4 stale observations and stream run mismatches never become current zero snapshots", async () => {
	const { freezeActivityRepo } = await import("./activity-store");
	const s = await setup();
	s.repo.observation = {
		version: "old",
		window: s.lease.run.window,
		refreshedAt: "2026-01-01T00:00:00Z",
		source: "run",
	};
	s.lease.run.activityWindow = {
		since: "2025-01-01T00:00:00Z",
		until: now,
		gap: true,
		first: false,
	};
	await s.db.batch([await freezeActivityRepo(s.db, s.lease, now, s.repo, extra())]);
	const row = await s.db
		.prepare("SELECT payload FROM factory_resources WHERE stream='activity-snapshot'")
		.first<{ payload: string }>();
	const data = JSON.parse(row?.payload ?? "{}");
	expect(data.snapshot.open_prs).toBeNull();
	expect(data.ci_runs).toBeNull();
	expect(data.commits.default).toBeNull();
	expect(data.coverage.actions).toMatchObject({ status: "partial", truncated: true });
});
it("freezes current activity even when passed previous repository metadata", async () => {
	const { freezeActivityRepo } = await import("./activity-store");
	const fixture = await setup("nocoo/lizheng.dev");
	const { db, lease, repo } = fixture;
	await seedLanded(fixture, [
		{
			sha: "current-sha",
			at: now,
			author: null,
			message: "Current",
			branch: "trunk",
			url: "",
			is_default_branch: true,
		},
	]);
	for (const stream of FACTORY_STREAMS) repo.coverage[stream].status = "complete";
	repo.coverage.dependencies = {
		...repo.coverage.dependencies,
		status: "limited",
		reason_code: "dependency_parse_unsupported",
		reason: "Workflow jobs cannot be parsed safely",
	};
	repo.observation = {
		version: "r1",
		window: { ...lease.run.window, until: "2026-10-21T20:00:00.000Z" },
		refreshedAt: "2026-10-21T20:00:00.000Z",
		source: "run",
	};
	await db.batch(await repositoryWrites(db, lease, now, repo, repo.name, null));
	const refreshed = structuredClone(repo);
	refreshed.branch = "trunk";
	refreshed.observation = {
		version: lease.run.id,
		window: lease.run.window,
		refreshedAt: now,
		source: "run",
	};
	await db.batch(await repositoryWrites(db, lease, now, refreshed, repo.name, null));
	expect(await currentRepo(db, lease.run.account_id, repo.name)).toMatchObject({
		branch: "trunk",
		observation: refreshed.observation,
		coverage: { dependencies: { retained: true, observation: repo.observation } },
	});
	const retained = repo;
	for (const step of lease.run.steps) {
		step.status = step.kind === "dependencies" ? "limited" : "success";
		step.error = step.kind === "dependencies" ? "dependency_parse_unsupported" : null;
		if (step.kind === "metadata") Object.assign(step, { sourceBranch: refreshed.branch });
	}
	const events = {
		prs: [{ id: 1, created_at: now, merged_at: now, base: { ref: "main" } }],
		issues: [{ id: 2, created_at: now, state: "open" }],
		actions: [
			{
				id: 3,
				workflow_id: 4,
				created_at: now,
				status: "completed",
				conclusion: "failure",
				event: "push",
				head_branch: "trunk",
			},
		],
		releases: [{ id: 5, published_at: now }],
		commits: [{ sha: "current-sha", commit: { committer: { date: now }, message: "Current" } }],
	};
	for (const stream of ["prs", "issues", "actions", "releases", "commits"] as const)
		await db
			.prepare("UPDATE factory_resources SET payload=? WHERE run_id=? AND repo=? AND stream=?")
			.bind(
				JSON.stringify({
					runId: lease.run.id,
					items: mapFactoryEvents(stream, events[stream]),
					coverage: repo.coverage[stream],
					next: null,
					ranges: [],
				}),
				lease.run.id,
				repo.name,
				stream,
			)
			.run();
	await db.batch([await freezeActivityRepo(db, lease, now, retained, extra())]);
	const writes = await activityPublicationWrites(db, lease, now, [retained]);
	lease.run.status = "completed";
	expect(await saveRun(db, lease, writes, now)).toBe(true);
	const data = await readActivity(createDb(fixture.raw), lease.run.account_id, {});
	const activity = data.repos[0];
	expect(activity).toMatchObject({
		prs: { merged: [{ id: "1" }] },
		issues: { opened: [{ id: "2" }] },
		ci_runs: [{ id: 3, is_default_branch: true }],
		releases: [{ id: "5" }],
		commits: { default: 1, other: 0, items: [{ sha: "current-sha", branch: "trunk" }] },
		coverage: { default_branch: { status: "complete" } },
		snapshot: { open_prs: [], open_issues: { other: [{ id: "2" }] } },
	});
	for (const stream of Object.keys(events))
		expect(activity?.coverage[stream]).toMatchObject({ status: "complete", truncated: false });
	expect(data.totals).toMatchObject({ ci_runs: 1, merged_prs: 1, issues_opened: 1, releases: 1 });
	expect(data.totals.red_default_branch).toMatchObject([{ id: 3, repo: repo.name }]);
	expect((await currentRepo(db, lease.run.account_id, repo.name))?.branch).toBe("trunk");
	expect((await currentRepo(db, lease.run.account_id, repo.name))?.observation).toEqual(
		refreshed.observation,
	);
});
it.each(["missing-step", "failed-step", "missing-branch", "null-branch", "other-repo", "accepted"])(
	"does not infer a current default branch without verified metadata (%s)",
	async (mode) => {
		const { freezeActivityRepo } = await import("./activity-store");
		const { db, lease, repo } = await setup();
		repo.observation = {
			version: mode === "accepted" ? lease.run.id : "old",
			window: lease.run.window,
			refreshedAt: now,
			source: "run",
		};
		for (const step of lease.run.steps) step.status = "success";
		const metadata = lease.run.steps.find(
			(step) => step.kind === "metadata" && step.repo === repo.name,
		);
		if (!metadata) throw new Error("Missing metadata step");
		if (mode === "missing-step")
			lease.run.steps = lease.run.steps.filter((step) => step !== metadata);
		if (mode === "failed-step")
			Object.assign(metadata, { status: "failed", sourceBranch: "trunk" });
		if (mode === "null-branch") Object.assign(metadata, { sourceBranch: null });
		if (mode === "other-repo")
			Object.assign(metadata, { repo: "nocoo/other", sourceBranch: "trunk" });
		await db
			.prepare(
				"UPDATE factory_resources SET payload=? WHERE run_id=? AND repo=? AND stream='actions'",
			)
			.bind(
				JSON.stringify({
					runId: lease.run.id,
					items: mapFactoryEvents("actions", [
						{
							id: 1,
							created_at: now,
							head_branch: "main",
							event: "push",
							status: "completed",
							conclusion: "failure",
						},
						{
							id: 2,
							created_at: now,
							head_branch: "main",
							event: "push",
							status: "completed",
							conclusion: "success",
						},
					]),
					coverage: { ...repo.coverage.actions, status: "complete" },
					next: null,
					ranges: [],
				}),
				lease.run.id,
				repo.name,
			)
			.run();
		await db.batch([await freezeActivityRepo(db, lease, now, repo, extra())]);
		const row = await db
			.prepare("SELECT payload FROM factory_resources WHERE stream='activity-snapshot'")
			.first<{ payload: string }>();
		const activity = JSON.parse(row?.payload ?? "{}");
		expect(activity.ci_runs).toMatchObject([
			{ is_default_branch: null },
			{ is_default_branch: null },
		]);
		expect(activity.coverage.default_branch).toMatchObject({
			status: "unavailable",
			truncated: false,
		});
		expect(repo.branch).toBe("main");
	},
);
it.each([
	[null, false],
	[null, true],
	["main", false],
	["main", true],
] as const)(
	"publishes red CI totals with branch %s and successful runs %s",
	async (branch, hasRuns) => {
		const { freezeActivityRepo } = await import("./activity-store");
		const { db, lease, repo } = await setup();
		for (const step of lease.run.steps) step.status = "success";
		const metadata = lease.run.steps.find((step) => step.kind === "metadata");
		if (!metadata) throw new Error("Missing metadata step");
		metadata.sourceBranch = branch;
		const items = hasRuns
			? mapFactoryEvents("actions", [
					{
						id: 1,
						created_at: now,
						head_branch: "main",
						event: "push",
						status: "completed",
						conclusion: "success",
					},
				])
			: [];
		await db
			.prepare(
				"UPDATE factory_resources SET payload=? WHERE run_id=? AND repo=? AND stream='actions'",
			)
			.bind(
				JSON.stringify({
					runId: lease.run.id,
					items,
					coverage: { ...repo.coverage.actions, status: "complete" },
					next: null,
					ranges: [],
				}),
				lease.run.id,
				repo.name,
			)
			.run();
		await db.batch([await freezeActivityRepo(db, lease, now, repo, extra())]);
		const writes = await activityPublicationWrites(db, lease, now, [repo]);
		lease.run.status = "completed";
		expect(await saveRun(db, lease, writes, now)).toBe(true);
		const data = await readActivity(db, "account_123", {});
		expect(data.repos[0]?.coverage.default_branch?.status).toBe(
			branch ? "complete" : "unavailable",
		);
		expect(data.totals.ci_runs).toBe(items.length);
		expect(data.totals.red_default_branch).toEqual(branch ? [] : null);
	},
);
it.each([
	"success",
	"missing-id",
	"pending",
	"failed",
	"missing-commit",
	"other-repo",
	"wrong-id",
	"wrong-stream-run",
])("R4 validates retained activity commit and identity evidence (%s)", async (mode) => {
	const { freezeActivityRepo } = await import("./activity-store");
	const { db, lease, repo } = await setup();
	repo.observation = { version: "old", window: lease.run.window, refreshedAt: now, source: "run" };
	const commit = lease.run.steps.find((step) => step.repo === repo.name && step.kind === "commit");
	if (!commit) throw new Error("Missing commit step");
	commit.status = mode === "pending" || mode === "failed" ? mode : "success";
	if (mode === "missing-commit")
		lease.run.steps = lease.run.steps.filter((step) => step !== commit);
	if (mode === "other-repo") commit.repo = "nocoo/other";
	if (mode === "wrong-id") lease.run.repoIds[repo.name] = "different-repository";
	if (mode === "missing-id") delete lease.run.repoIds[repo.name];
	if (mode === "wrong-stream-run")
		await db
			.prepare("UPDATE factory_resources SET payload=json_set(payload,'$.runId','old')")
			.run();
	await db.batch([await freezeActivityRepo(db, lease, now, repo, extra())]);
	const row = await db
		.prepare("SELECT payload FROM factory_resources WHERE stream='activity-snapshot'")
		.first<{ payload: string }>();
	const activity = JSON.parse(row?.payload ?? "{}");
	const current = mode === "success" || mode === "missing-id";
	expect(activity.snapshot.open_prs).toEqual(current ? [] : null);
	expect(activity.ci_runs).toEqual(current ? [] : null);
	expect(activity.commits.default).toBeNull();
	expect(activity.coverage.actions.status).toBe(current ? "complete" : "unavailable");
});
it("R9 activity never substitutes live security snapshots for missing staged evidence", async () => {
	const { freezeActivityRepo } = await import("./activity-store");
	const s = await setup();
	s.repo.observation = {
		version: "r2",
		window: s.lease.run.window,
		refreshedAt: now,
		source: "run",
	};
	const step = s.lease.run.steps.find((step) => step.resource === "repo:nocoo/app:security");
	if (!step) throw new Error("fixture");
	Object.assign(step, { status: "success", startedAt: now, finishedAt: now });
	await s.db
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('account_123','repo:nocoo/app:security',?,?)",
		)
		.bind(
			JSON.stringify({
				fetched_at: now,
				features: { dependabot: { status: "available" }, code_scanning: { status: "available" } },
				dependabot_open: 7,
				code_scanning_open: 9,
			}),
			now,
		)
		.run();
	await s.db.batch([await freezeActivityRepo(s.db, s.lease, now, s.repo, extra())]);
	const row = await s.db
		.prepare("SELECT payload FROM factory_resources WHERE stream='activity-snapshot'")
		.first<{ payload: string }>();
	expect(JSON.parse(row?.payload ?? "{}").snapshot).toMatchObject({
		dependabot: null,
		code_scanning: null,
	});
});
it("R4 incomplete source batches fail closed and missing metadata cannot publish a fake repository", async () => {
	const { freezeActivityRepo } = await import("./activity-store");
	const { vi } = await import("vitest");
	const s = await setup();
	vi.spyOn(s.db, "batch").mockResolvedValueOnce([]);
	await expect(freezeActivityRepo(s.db, s.lease, now, s.repo, extra())).rejects.toMatchObject({
		code: "db_error",
	});
	await expect(activityPublicationWrites(s.db, s.lease, now, [])).rejects.toMatchObject({
		code: "snapshot_missing",
	});
	if (s.lease.run.steps[0]) s.lease.run.steps[0].status = "failed";
	await seedFrozenSnapshot(s.db, s.lease, s.repo);
	expect((await activityPublicationWrites(s.db, s.lease, now, [s.repo])).length).toBeGreaterThan(0);
	s.lease.run.depth = "deep";
	expect(await activityPublicationWrites(s.db, s.lease, now, [s.repo])).toEqual([]);
});
it("R4 existing activity headers cannot acquire changed or extra immutable pages", async () => {
	const s = await setup();
	await seedFrozenSnapshot(s.db, s.lease, s.repo);
	const readDb = () => createDb(s.raw, undefined, 10_000);
	await s.db.batch(await activityPublicationWrites(readDb(), s.lease, now, [s.repo]));
	const before = await s.db.prepare("SELECT payload FROM activity_pages").all();
	const item = activityRepo(
		s.repo,
		new Map(),
		s.lease.run.activityWindow ?? snapshotFor([]).window,
		null,
		null,
	);
	item.repo = "changed";
	await s.db
		.prepare(
			"UPDATE factory_resources SET payload=? WHERE run_id='r2' AND repo='nocoo/app' AND stream='activity-snapshot'",
		)
		.bind(JSON.stringify(item))
		.run();
	await s.db.batch(await activityPublicationWrites(readDb(), s.lease, now, [s.repo]));
	expect((await s.db.prepare("SELECT payload FROM activity_pages").all()).results).toEqual(
		before.results,
	);
});
it("R4 known unselected repositories return an empty scoped window while unknown repositories fail", async () => {
	const s = await setup();
	await seedFrozenSnapshot(s.db, s.lease, s.repo);
	const writes = await activityPublicationWrites(s.db, s.lease, now, [s.repo]);
	s.lease.run.status = "completed";
	await saveRun(s.db, s.lease, writes, now);
	await createDb(s.raw)
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('account_123','repos',?,?)",
		)
		.bind(JSON.stringify({ repos: [{ name_with_owner: "nocoo/other" }] }), now)
		.run();
	const data = await readActivity(createDb(s.raw), "account_123", { repository: ["nocoo/other"] });
	expect(data.repos).toEqual([]);
	expect(data.totals).toMatchObject({ ci_runs: 0, merged_prs: 0 });
	expect(data.contributions).toBeNull();
	await expect(
		readActivity(createDb(s.raw), "account_123", { repository: ["nocoo/missing"] }),
	).rejects.toMatchObject({ status: 404 });
	for (const query of [{ run: [""] }, { repository: ["invalid"] }, { unknown: ["value"] }])
		await expect(readActivity(createDb(s.raw), "account_123", query)).rejects.toMatchObject({
			status: 400,
		});
});
it("R4 packer caps page count and never loops on oversized non-list metadata", () => {
	const repo = activityRepo(mapFactoryRepo(rawRepo), new Map(), snapshotFor([]).window, null, null);
	const large = { ...repo, repo: "x".repeat(1_500_001) };
	expect(() => packActivity(snapshotFor([large]))).toThrow("repository metadata");
	const header = snapshotFor([]);
	header.account_id = "x".repeat(1_500_001);
	expect(() => packActivity(header)).toThrow("metadata exceeds");
	const event = {
		id: "1",
		title: "x".repeat(1_250_000),
		url: "",
		at: now,
		createdAt: now,
		closedAt: null,
		mergedAt: null,
		author: null,
		state: "published",
	};
	const packed = packActivity(
		snapshotFor(
			Array.from({ length: 17 }, (_, index) => ({
				...repo,
				repo: `nocoo/r${index}`,
				releases: [event],
			})),
		),
	);
	expect(packed.pages).toHaveLength(16);
	expect(packed.header.truncated).toBe(true);
	expect(Object.values(packed.header.totals).every((value) => value === null)).toBe(true);
});
it("R4 red-workflow header copies obey the same UTF-8 cap as repository pages", () => {
	const repo = activityRepo(mapFactoryRepo(rawRepo), new Map(), snapshotFor([]).window, null, null);
	const run = {
		id: 1,
		workflow_id: 1,
		workflow_name: "x".repeat(12_000),
		event: "push",
		head_branch: "main",
		head_sha: "s",
		is_default_branch: true,
		status: "completed",
		conclusion: "failure",
		run_attempt: 1,
		created_at: now,
		updated_at: now,
		run_started_at: now,
		duration_s: 0,
		html_url: "",
		actor: null,
		path: null,
	};
	const snapshots = Array.from({ length: 4 }, () => ({
		...repo,
		ci_runs: Array.from({ length: 50 }, () => run),
		coverage: {
			...repo.coverage,
			actions: { status: "complete" as const, truncated: false, reason: null },
			default_branch: { status: "complete" as const, truncated: false, reason: null },
		},
	}));
	const packed = packActivity(snapshotFor(snapshots));
	expect(new TextEncoder().encode(JSON.stringify(packed.header)).length).toBeLessThanOrEqual(
		1_500_000,
	);
	expect(packed.header.coverage.totals).toMatchObject({ truncated: true });
});
it.each(["completed", "partial"] as const)(
	"B2 bounded GC keeps the latest two %s activity publications",
	async (status) => {
		const { pruneFactory } = await import("./factory-retention");
		const s = await setup();
		for (let index = 0; index < 3; index++) {
			const at = `2020-01-0${index + 1}T00:00:00.000Z`;
			const id = `old${index}`;
			await s.db
				.prepare(
					"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'account_123',?,?,'{}',?,?,?)",
				)
				.bind(id, id, status, at, at, at)
				.run();
			await s.db
				.prepare(
					"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('account_123',?,?,?,'{}','h')",
				)
				.bind(id, at, at)
				.run();
			await s.db
				.prepare("INSERT INTO activity_pages VALUES('account_123',?,0,'[]')")
				.bind(id)
				.run();
		}
		const budget = await s.db
			.prepare("SELECT bytes FROM factory_budget WHERE account_id='account_123'")
			.first<{ bytes: number }>();
		expect(budget?.bytes).toBeGreaterThanOrEqual(12);
		for (let index = 0; index < 22; index++)
			await createDb(s.raw)
				.prepare(
					"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'account_123',?,'failed','{}',?,?,?)",
				)
				.bind(`failed${index}`, `failed${index}`, now, now, now)
				.run();
		await pruneFactory(createDb(s.raw), now);
		const retained = await createDb(s.raw)
			.prepare("SELECT run_id FROM activity_publications ORDER BY run_id")
			.all<{ run_id: string }>();
		expect(retained.results).toEqual([{ run_id: "old1" }, { run_id: "old2" }]);
		expect(
			(
				await createDb(s.raw)
					.prepare("SELECT COUNT(*) AS n FROM activity_pages")
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	},
);
it("R4 mixed current security retains an available feature without reviving stale failed snapshots", async () => {
	const { freezeActivityRepo } = await import("./activity-store");
	const s = await setup();
	s.repo.observation = {
		version: "r2",
		window: s.lease.run.window,
		refreshedAt: now,
		source: "run",
	};
	const step = s.lease.run.steps.find((step) => step.resource === "repo:nocoo/app:security");
	if (!step) throw new Error("fixture");
	step.status = "unavailable";
	step.startedAt = now;
	step.finishedAt = now;
	const payload = {
		fetched_at: now,
		features: { dependabot: { status: "available" }, code_scanning: { status: "unavailable" } },
		dependabot_open: 4,
		code_scanning_open: null,
	};
	await s.db
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('r2','','site:repo:nocoo/app:security',?)",
		)
		.bind(JSON.stringify(payload))
		.run();
	await s.db.batch([await freezeActivityRepo(s.db, s.lease, now, s.repo, extra())]);
	const row = await s.db
		.prepare("SELECT payload FROM factory_resources WHERE stream='activity-snapshot'")
		.first<{ payload: string }>();
	expect(JSON.parse(row?.payload ?? "{}").snapshot).toMatchObject({
		dependabot: 4,
		code_scanning: null,
	});
});
it("R4 capacity-omitted frozen members remain truncated unknown, never complete unselected zero", async () => {
	const s = await setup();
	const header = {
		...snapshotFor([]),
		membership: ["nocoo/app", "nocoo/omitted"],
		truncated: true,
		coverage: { repos: { status: "partial", truncated: true, reason: "capacity" } },
	};
	await s.db.prepare("UPDATE factory_runs SET status='completed' WHERE id='r2'").run();
	await s.db
		.prepare(
			"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('account_123','r2',?,? ,?,'h')",
		)
		.bind(now, now, JSON.stringify(header))
		.run();
	await s.db
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('account_123','repos',?,?)",
		)
		.bind(
			JSON.stringify({
				repos: [{ name_with_owner: "nocoo/omitted" }, { name_with_owner: "nocoo/unselected" }],
			}),
			now,
		)
		.run();
	const dropped = await readActivity(createDb(s.raw), "account_123", {
		repository: ["nocoo/omitted"],
	});
	expect(dropped.repos).toEqual([]);
	expect(dropped.truncated).toBe(true);
	expect(dropped.totals.merged_prs).toBeNull();
	expect(dropped.coverage.repos).toMatchObject({ status: "partial", truncated: true });
	const unselected = await readActivity(createDb(s.raw), "account_123", {
		repository: ["nocoo/unselected"],
	});
	expect(unselected.truncated).toBe(false);
	expect(unselected.totals.merged_prs).toBe(0);
});
it("R4 publishes unknown-branch failures as nullable red totals through authenticated browser and machine APIs", async () => {
	const { freezeActivityRepo } = await import("./activity-store");
	const { mapFactoryEvents } = await import("./factory-map");
	const { createApp } = await import("../index");
	const { createApiToken } = await import("./api-tokens");
	const s = await setup();
	const metadata = s.lease.run.steps.find((step) => step.kind === "metadata");
	if (!metadata) throw new Error("Missing metadata step");
	Object.assign(metadata, { status: "success", sourceBranch: "main" });
	s.repo.observation = {
		version: "r2",
		window: s.lease.run.window,
		refreshedAt: now,
		source: "run",
	};
	const actions = {
		runId: "r2",
		items: mapFactoryEvents("actions", [
			{
				id: 4,
				workflow_id: 1,
				name: "CI",
				event: "push",
				head_branch: null,
				head_sha: "abc",
				run_attempt: 1,
				created_at: now,
				status: "completed",
				conclusion: "failure",
				actor: { login: "nocoo" },
			},
		]),
		next: null,
		ranges: [],
		coverage: { ...s.repo.coverage.actions, status: "complete" },
	};
	await s.db
		.prepare("UPDATE factory_resources SET payload=? WHERE run_id='r2' AND stream='actions'")
		.bind(JSON.stringify(actions))
		.run();
	await s.db.batch([await freezeActivityRepo(s.db, s.lease, now, s.repo, extra())]);
	const writes = await activityPublicationWrites(s.db, s.lease, now, [s.repo]);
	s.lease.run.status = "completed";
	await saveRun(s.db, s.lease, writes, now);
	expect(
		(
			await createDb(s.raw)
				.prepare("SELECT COUNT(*) AS n FROM activity_pages")
				.first<{ n: number }>()
		)?.n,
	).toBe(1);
	await createDb(s.raw).prepare("UPDATE accounts SET is_active=1").run();
	const token = await createApiToken(createDb(s.raw), {
		accountId: "account_123",
		label: "activity-test",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	const app = createApp();
	const env = {
		DB: s.raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as import("../env").Env;
	for (const path of ["/api/activity", "/api/v1/accounts/account_123/activity"]) {
		const headers = { Authorization: `Bearer ${token.token}` };
		const response = await app.request(`http://localhost${path}`, { headers }, env);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			totals: { ci_runs: 1, red_default_branch: null },
			repos: [{ coverage: { default_branch: { status: "partial" } } }],
		});
		const tag = response.headers.get("etag");
		if (!tag) throw new Error("etag missing");
		expect(
			(
				await app.request(
					`http://localhost${path}`,
					{ headers: { ...headers, "If-None-Match": tag } },
					env,
				)
			).status,
		).toBe(304);
	}
	expect(
		(await app.request("http://localhost/api/v1/accounts/account_123/activity", {}, env)).status,
	).toBe(401);
	expect(
		(
			await app.request(
				"http://localhost/api/v1/accounts/account_123/activity",
				{ method: "POST", headers: { Authorization: `Bearer ${token.token}` } },
				env,
			)
		).status,
	).toBe(405);
	await createDb(s.raw).prepare("UPDATE accounts SET is_active=0").run();
	expect((await app.request("http://localhost/api/activity", {}, env)).status).toBe(409);
});
it("R4 publication profiles metadata first and fetches at most four MB in frozen membership order", async () => {
	const { profileDb } = await import("../../../../../tests/fixtures/profile-db");
	const s = await setup();
	const names = [
		"nocoo/z-last-in-sql",
		"nocoo/a-first-in-sql",
		"nocoo/m-exact-fit",
		"nocoo/n-omitted",
	];
	s.lease.run.repos = names;
	s.lease.run.repoIds = Object.fromEntries(names.map((name) => [name, s.repo.id]));
	const metadata = names.map((name) => ({ ...s.repo, name }));
	const sizes = [1_499_998, 1_499_998, 1_000_004, 1_499_998];
	for (const [index, name] of [...names, "nocoo/outside-frozen-membership"].entries()) {
		const resources = new Map();
		for (const stream of FACTORY_STREAMS)
			resources.set(stream, {
				runId: "r2",
				items: [],
				next: null,
				ranges: [],
				coverage: { ...s.repo.coverage[stream], status: "complete" },
			});
		const record = activityRepo(
			{ ...s.repo, name },
			resources,
			s.lease.run.activityWindow ?? snapshotFor([]).window,
			extra(),
			null,
		);
		record.releases = [
			{
				id: "release",
				title: "",
				url: "",
				at: now,
				createdAt: now,
				closedAt: null,
				mergedAt: null,
				author: null,
				state: "published",
			},
		];
		const padding =
			(sizes[index] ?? 1_499_998) - new TextEncoder().encode(JSON.stringify(record)).length;
		const release = record.releases[0];
		if (!release) throw new Error("fixture");
		release.title = "界".repeat(Math.floor(padding / 3)) + "x".repeat(padding % 3);
		const payload = JSON.stringify(record);
		expect(new TextEncoder().encode(payload).length).toBe(sizes[index] ?? 1_499_998);
		await createDb(s.raw)
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('r2',?,'activity-snapshot',?)",
			)
			.bind(name, payload)
			.run();
	}
	const profile = profileDb(s.raw);
	await activityPublicationWrites(createDb(profile.raw), s.lease, now, metadata);
	expect(profile.queries).toHaveLength(2);
	expect(profile.queries[0]?.payloadBytes).toBe(0);
	expect(profile.queries[0]?.rows).toBe(names.length);
	expect(profile.queries.reduce((sum, query) => sum + query.payloadBytes, 0)).toBe(4_000_000);
	expect(profile.queries[1]?.rows).toBe(3);
	expect(profile.queries.every((query) => query.sql.includes("activity-snapshot"))).toBe(true);
	const publicationDb = createDb(s.raw);
	const writes = await activityPublicationWrites(publicationDb, s.lease, now, metadata);
	s.lease.run.status = "completed";
	expect(await saveRun(publicationDb, s.lease, writes, now)).toBe(true);
	const result = await readActivity(createDb(s.raw), "account_123", {});
	expect(result.membership).toEqual(names);
	expect(result.repos.map((repo) => repo.repo)).toEqual(names.slice(0, 3));
	expect(result.truncated).toBe(true);
	expect(result.totals.releases).toBe(3);
	expect(result.totals_partial).toBe(true);
	expect(result.totals_coverage.missing).toContainEqual({
		repo: names[3],
		metrics: Object.keys(result.totals),
		reason: "omitted",
	});
	expect(result.coverage.input).toMatchObject({ status: "partial", truncated: true });
	const omitted = await readActivity(createDb(s.raw), "account_123", {
		repository: [names[3] ?? ""],
	});
	expect(omitted.repos).toEqual([]);
	expect(omitted.truncated).toBe(true);
	expect(omitted.totals.merged_prs).toBeNull();
});
it("R4 publication freezes complete bounded contribution coverage without losing authoritative zero", async () => {
	const s = await setup();
	const types = {
		commits: 0,
		issues: 0,
		pullRequests: 0,
		pullRequestReviews: 0,
		restricted: 0,
		repositories: 0,
	};
	s.lease.run.activityContributions = {
		timezone: "Asia/Shanghai",
		days: [
			{
				date: "2026-10-23",
				since: "2026-10-22T16:00:00.000Z",
				until: now,
				partial: true,
				count: 0,
				types,
				coverage: { status: "complete", truncated: false, reason: null },
				nativeCalendar: { timezone: "github", total: 0, days: [] },
			},
		],
	};
	await seedFrozenSnapshot(s.db, s.lease, s.repo);
	const writes = await activityPublicationWrites(s.db, s.lease, now, [s.repo]);
	s.lease.run.status = "completed";
	expect(await saveRun(s.db, s.lease, writes, now)).toBe(true);
	const data = await readActivity(createDb(s.raw), "account_123", {});
	expect(data.coverage.contributions).toMatchObject({ status: "complete" });
	expect(data.contributions?.days[0]?.count).toBe(0);
});
it.each(["missing-time", "missing-start", "missing-finish", "stale-time", "failed-step"])(
	"R4 rejects unverifiable saved feature coverage (%s)",
	async (mode) => {
		const { freezeActivityRepo } = await import("./activity-store");
		const s = await setup();
		s.repo.observation = {
			version: "r2",
			window: s.lease.run.window,
			refreshedAt: now,
			source: "run",
		};
		const step = s.lease.run.steps.find((step) => step.resource === "repo:nocoo/app:security");
		if (!step) throw new Error("fixture");
		step.status = mode === "failed-step" ? "failed" : "unavailable";
		step.startedAt = mode === "missing-start" ? null : now;
		step.finishedAt = mode === "missing-finish" ? null : now;
		const payload = {
			fetched_at:
				mode === "missing-time" ? null : mode === "stale-time" ? "2020-01-01T00:00:00.000Z" : now,
			features: { dependabot: { status: "available" }, code_scanning: { status: "available" } },
			dependabot_open: 4,
			code_scanning_open: 8,
		};
		await s.db
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('r2','','site:repo:nocoo/app:security',?)",
			)
			.bind(JSON.stringify(payload))
			.run();
		await s.db.batch([await freezeActivityRepo(s.db, s.lease, now, s.repo, extra())]);
		const row = await s.db
			.prepare("SELECT payload FROM factory_resources WHERE stream='activity-snapshot'")
			.first<{ payload: string }>();
		expect(JSON.parse(row?.payload ?? "{}").snapshot).toMatchObject({
			dependabot: null,
			code_scanning: null,
		});
	},
);
it("R4 imported incomplete header metadata remains conservative for filtered known repositories", async () => {
	const s = await setup();
	const repo = activityRepo(s.repo, new Map(), snapshotFor([]).window, null, null);
	const header = { ...snapshotFor([]), truncated: true };
	await s.db.prepare("UPDATE factory_runs SET status='completed' WHERE id='r2'").run();
	await s.db
		.prepare(
			"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('account_123','r2',?,? ,?,'h')",
		)
		.bind(now, now, JSON.stringify(header))
		.run();
	await s.db
		.prepare("INSERT INTO activity_pages VALUES('account_123','r2',0,?)")
		.bind(JSON.stringify([repo]))
		.run();
	await s.db
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('account_123','repos',?,?)",
		)
		.bind(JSON.stringify({ repos: [{ name_with_owner: "nocoo/other" }] }), now)
		.run();
	const imported = await readActivity(createDb(s.raw), "account_123", {
		repository: ["nocoo/app"],
	});
	expect(imported.coverage.repos).toMatchObject({ status: "unavailable" });
	const unknown = await readActivity(createDb(s.raw), "account_123", {
		repository: ["nocoo/other"],
	});
	expect(unknown.truncated).toBe(true);
	expect(unknown.totals.ci_runs).toBeNull();
});
it("R4 oversized account metadata fails boundedly even when red-workflow evidence is unavailable", () => {
	const repo = activityRepo(mapFactoryRepo(rawRepo), new Map(), snapshotFor([]).window, null, null);
	const snapshot = snapshotFor([repo]);
	snapshot.account_id = "x".repeat(1_500_001);
	expect(() => packActivity(snapshot)).toThrow("metadata exceeds page capacity");
});

import { Hono } from "hono";
