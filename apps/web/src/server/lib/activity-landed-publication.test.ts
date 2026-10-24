import { expect, it } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { ActivityCommit, ActivityRepo } from "../../lib/activity-types";
import { type FactoryRun, makeRun } from "../../lib/factory-run";
import { FACTORY_STREAMS, type FactoryRepo } from "../../lib/factory-types";
import { requireActivityWindow } from "./activity";
import type { ActivitySupplement } from "./activity-collect";
import { readLandedActivity } from "./activity-landed";
import { activityPublicationWrites, freezeActivityRepo, readActivity } from "./activity-store";
import { createDb } from "./db/d1";
import { claimRun, controlRun, type RunLease, saveRun, startRun } from "./db/factory-runs";
import { mapFactoryRepo } from "./factory-map";

const FIRST = "2026-10-22T22:14:55.000Z";
const SECOND = "2026-10-23T22:14:55.000Z";
const THIRD = "2026-10-25T22:14:55.000Z";
const ACCOUNT = "account_123";
const supplement = (): ActivitySupplement => ({
	commits: [],
	tags: [],
	last_success_at: null,
	coverage: {},
	phase: "done",
	after: null,
	tagAfter: null,
	pending: [],
	deployNext: null,
	pages: 0,
});

function commit(sha: string, run: FactoryRun, bootstrap = false): ActivityCommit {
	return {
		sha,
		author: "fixture-owner",
		message: `Old-dated work ${sha}`,
		at: "2026-10-20T21:50:00.000Z",
		url: `https://fixture.invalid/commit/${sha}`,
		branch: "main",
		is_default_branch: true,
		observation: {
			runId: run.id,
			window: requireActivityWindow(run),
			at: run.startedAt,
			bootstrap,
		},
	};
}

async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw, undefined, 10_000);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?, 'fixture-owner','fake-envelope','fake',?,?)",
		)
		.bind(ACCOUNT, FIRST, FIRST)
		.run();
	const repo = mapFactoryRepo(rawRepo);
	async function start(id: string, at: string, selected: FactoryRepo = repo) {
		const run = makeRun(
			id,
			ACCOUNT,
			"fixture-owner",
			id,
			"refresh",
			[selected],
			at,
			[],
			[selected.name],
			{ scope: "all" },
			"quick",
		);
		await startRun(db, run);
		const lease = await claimRun(db, id, at);
		if (!lease) throw new Error("Missing fixture lease");
		for (const step of lease.run.steps) step.status = "success";
		const metadata = lease.run.steps.find((step) => step.kind === "metadata");
		if (!metadata) throw new Error("Missing fixture metadata");
		metadata.sourceHead = "fixture-head";
		metadata.sourceBranch = "main";
		await db.batch(
			FACTORY_STREAMS.map((stream) =>
				db
					.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
					.bind(
						id,
						selected.name,
						stream,
						JSON.stringify({
							runId: id,
							items: [],
							next: null,
							ranges: [],
							coverage: { ...selected.coverage[stream], status: "complete" },
						}),
					),
			),
		);
		await db
			.prepare(
				"INSERT INTO activity_commit_heads VALUES(?,?,?,NULL) ON CONFLICT(account_id,repo_id) DO UPDATE SET head=excluded.head,pending=NULL",
			)
			.bind(ACCOUNT, selected.id, "fixture-head")
			.run();
		return lease;
	}
	async function seed(items: ActivityCommit[], selected: FactoryRepo = repo) {
		await db
			.prepare(
				"INSERT INTO activity_commit_ledger(account_id,repo_id,sha,first_run_id,observed_at,window_since,window_until,payload) SELECT ?,?,json_extract(value,'$.sha'),json_extract(value,'$.observation.runId'),json_extract(value,'$.observation.at'),json_extract(value,'$.observation.window.since'),json_extract(value,'$.observation.window.until'),value FROM json_each(?)",
			)
			.bind(ACCOUNT, selected.id, JSON.stringify(items))
			.run();
	}
	async function freeze(lease: RunLease, selected: FactoryRepo = repo) {
		await db.batch([
			await freezeActivityRepo(db, lease, lease.run.startedAt, selected, supplement()),
		]);
		const row = await db
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream='activity-snapshot'",
			)
			.bind(lease.run.id, selected.name)
			.first<{ payload: string }>();
		if (!row) throw new Error("Missing frozen fixture");
		return JSON.parse(row.payload) as ActivityRepo;
	}
	async function publish(lease: RunLease, selected: FactoryRepo = repo) {
		const writes = await activityPublicationWrites(db, lease, lease.run.startedAt, [selected]);
		lease.run.status = "completed";
		expect(await saveRun(db, lease, writes, lease.run.startedAt)).toBe(true);
		return readActivity(db, ACCOUNT, { run: [lease.run.id] });
	}
	const ledger = () =>
		db
			.prepare(
				"SELECT repo_id,sha,first_run_id,observed_at,window_since,window_until,payload,published_run_id FROM activity_commit_ledger WHERE account_id=? ORDER BY repo_id,sha",
			)
			.bind(ACCOUNT)
			.all<{
				repo_id: string;
				sha: string;
				first_run_id: string;
				observed_at: string;
				window_since: string;
				window_until: string;
				payload: string | null;
				published_run_id: string | null;
			}>();
	return { raw, db, repo, start, seed, freeze, publish, ledger };
}

it("freezes current and deferred first observations, then marks only packed identities atomically with saveRun", async () => {
	const s = await setup();
	const abandoned = await s.start("abandoned", FIRST);
	const earlier = commit("deferred-bootstrap", abandoned.run, true);
	await s.seed([earlier]);
	await controlRun(s.db, ACCOUNT, abandoned.run.id, "cancel", FIRST);
	const lease = await s.start("publication", SECOND);
	const current = commit("current-old-date", lease.run);
	await s.seed([current]);
	const before = await s.ledger();
	const landed = await readLandedActivity(s.db, lease.run, s.repo);
	expect(landed.items).toEqual([current]);
	expect(landed.deferred).toEqual([
		{ runId: abandoned.run.id, window: requireActivityWindow(abandoned.run), items: [earlier] },
	]);
	const frozen = await s.freeze(lease);
	expect(frozen.commits).toMatchObject({
		default: 1,
		items: landed.items,
		deferred: landed.deferred,
	});
	expect(await s.ledger()).toEqual(before);
	const late = commit("arrived-after-freeze", lease.run);
	await s.seed([late]);
	const writes = await activityPublicationWrites(s.db, lease, SECOND, [s.repo]);
	expect((await s.ledger()).results.every((row) => row.published_run_id === null)).toBe(true);
	expect((await s.db.prepare("SELECT * FROM activity_publications").all()).results).toEqual([]);
	lease.run.status = "completed";
	expect(await saveRun(s.db, lease, writes, SECOND)).toBe(true);
	const saved = await readActivity(s.db, ACCOUNT, {});
	expect(saved.repos[0]?.commits).toEqual(frozen.commits);
	const rows = (await s.ledger()).results;
	for (const sha of [earlier.sha, current.sha])
		expect(rows.find((row) => row.sha === sha)).toMatchObject({
			published_run_id: lease.run.id,
			payload: null,
		});
	expect(rows.find((row) => row.sha === earlier.sha)).toMatchObject({
		first_run_id: abandoned.run.id,
		window_since: earlier.observation?.window.since,
		window_until: earlier.observation?.window.until,
		observed_at: FIRST,
	});
	expect(rows.find((row) => row.sha === late.sha)).toMatchObject({
		published_run_id: null,
		payload: JSON.stringify(late),
	});
});

it("does not double count a second publication and preserves the first immutable publication", async () => {
	const s = await setup();
	const first = await s.start("first-publication", FIRST);
	await s.seed([commit("once-only", first.run, true)]);
	await s.freeze(first);
	const original = await s.publish(first);
	const second = await s.start("second-publication", SECOND);
	expect(requireActivityWindow(second.run)).toMatchObject({
		since: FIRST,
		until: SECOND,
		first: false,
	});
	expect(await readLandedActivity(s.db, second.run, s.repo)).toMatchObject({
		items: [],
		deferred: [],
		coverage: { status: "complete" },
	});
	await s.seed([commit("new-once", second.run)]);
	expect((await s.freeze(second)).commits).toMatchObject({
		default: 1,
		items: [{ sha: "new-once" }],
		deferred: [],
	});
	const next = await s.publish(second);
	expect(next.repos[0]?.commits.items?.map((item) => item.sha)).toEqual(["new-once"]);
	expect(await readActivity(s.db, ACCOUNT, { run: [first.run.id] })).toEqual(original);
	expect((await s.ledger()).results).toMatchObject([
		{ sha: "new-once", published_run_id: second.run.id, payload: null },
		{ sha: "once-only", published_run_id: first.run.id, payload: null },
	]);
});

it("immutable retries neither change pages nor consume late pending commits from a changed frozen record", async () => {
	const s = await setup();
	const lease = await s.start("retry-publication", FIRST);
	await s.seed([commit("original", lease.run)]);
	await s.freeze(lease);
	expect(
		await saveRun(
			s.db,
			lease,
			await activityPublicationWrites(s.db, lease, FIRST, [s.repo]),
			FIRST,
			true,
		),
	).toBe(true);
	const header = await s.db.prepare("SELECT * FROM activity_publications").all();
	const pages = await s.db.prepare("SELECT * FROM activity_pages").all();
	const late = commit("late", lease.run);
	await s.seed([late]);
	const changed = await s.freeze(lease);
	changed.commits.items = [...(changed.commits.items ?? []), late];
	await s.db
		.prepare("UPDATE factory_resources SET payload=? WHERE run_id=? AND stream='activity-snapshot'")
		.bind(JSON.stringify(changed), lease.run.id)
		.run();
	const writes = await activityPublicationWrites(s.db, lease, FIRST, [s.repo]);
	lease.run.status = "completed";
	expect(await saveRun(s.db, lease, writes, FIRST)).toBe(true);
	expect(await s.db.prepare("SELECT * FROM activity_publications").all()).toEqual(header);
	expect(await s.db.prepare("SELECT * FROM activity_pages").all()).toEqual(pages);
	expect((await s.ledger()).results.find((row) => row.sha === late.sha)).toMatchObject({
		payload: JSON.stringify(late),
		published_run_id: null,
	});
});

it.each(["pause", "supersede"] as const)(
	"a %s-revoked lease cannot publish or compact pending payloads",
	async (mode) => {
		const s = await setup();
		const lease = await s.start("stale-publication", FIRST);
		await s.seed([commit("unpublished", lease.run)]);
		await s.freeze(lease);
		const rows = await s.ledger();
		const writes = await activityPublicationWrites(s.db, lease, FIRST, [s.repo]);
		if (mode === "pause") await controlRun(s.db, ACCOUNT, lease.run.id, "pause", FIRST);
		else
			expect(await claimRun(s.db, lease.run.id, "2026-10-22T22:16:00.000Z", false)).not.toBeNull();
		lease.run.status = "completed";
		expect(await saveRun(s.db, lease, writes, FIRST)).toBe(false);
		expect(await s.ledger()).toEqual(rows);
		for (const table of ["activity_publications", "activity_pages"])
			expect((await s.db.prepare(`SELECT * FROM ${table}`).all()).results).toEqual([]);
	},
);

it("a failure after publication and ledger statements rolls back both with the run save", async () => {
	const s = await setup();
	const lease = await s.start("atomic-publication", FIRST);
	await s.seed([commit("must-survive", lease.run)]);
	await s.freeze(lease);
	const rows = await s.ledger();
	const writes = await activityPublicationWrites(s.db, lease, FIRST, [s.repo]);
	lease.run.status = "completed";
	await expect(
		saveRun(s.db, lease, [...writes, s.db.prepare("SELECT json('{')")], FIRST),
	).rejects.toMatchObject({ code: "db_error" });
	expect(await s.ledger()).toEqual(rows);
	expect((await s.db.prepare("SELECT * FROM activity_publications").all()).results).toEqual([]);
	expect((await s.db.prepare("SELECT * FROM activity_pages").all()).results).toEqual([]);
	expect(
		await s.db.prepare("SELECT status FROM factory_runs WHERE id=?").bind(lease.run.id).first(),
	).toEqual({ status: "running" });
});

it("first-window bootstrap remains deferred with its original attribution after cancellation and a multi-day gap", async () => {
	const s = await setup();
	const bootstrap = await s.start("bootstrap-cancelled", FIRST);
	expect(requireActivityWindow(bootstrap.run)).toMatchObject({ first: true, gap: true });
	const original = commit("bootstrap-pending", bootstrap.run, true);
	await s.seed([original]);
	await s.freeze(bootstrap);
	await controlRun(s.db, ACCOUNT, bootstrap.run.id, "cancel", FIRST);
	const resumed = await s.start("first-success-after-gap", THIRD);
	expect(requireActivityWindow(resumed.run)).toMatchObject({
		first: true,
		gap: true,
		until: THIRD,
	});
	const current = commit("current-after-gap", resumed.run);
	await s.seed([current]);
	const frozen = await s.freeze(resumed);
	expect(frozen.commits).toMatchObject({
		default: 1,
		items: [current],
		deferred: [
			{ runId: bootstrap.run.id, window: requireActivityWindow(bootstrap.run), items: [original] },
		],
	});
	const saved = await s.publish(resumed);
	expect(saved.repos[0]?.commits.deferred?.[0]?.items[0]?.observation).toEqual(
		original.observation,
	);
	expect((await s.ledger()).results.find((row) => row.sha === original.sha)).toMatchObject({
		first_run_id: bootstrap.run.id,
		observed_at: FIRST,
		published_run_id: resumed.run.id,
	});
});

it("renames follow the stable repository id while a replacement at the old name cannot consume its identities", async () => {
	const s = await setup();
	const original = await s.start("before-rename", FIRST);
	await s.seed([commit("same-sha", original.run)]);
	await controlRun(s.db, ACCOUNT, original.run.id, "cancel", FIRST);
	const renamed = { ...s.repo, name: "fixture-owner/renamed" };
	const renameLease = await s.start("after-rename", SECOND, renamed);
	expect(
		(await readLandedActivity(s.db, renameLease.run, renamed)).deferred[0]?.items.map(
			(item) => item.sha,
		),
	).toEqual(["same-sha"]);
	await s.freeze(renameLease, renamed);
	const renamedSnapshot = await s.publish(renameLease, renamed);
	expect(renamedSnapshot.repos[0]).toMatchObject({
		repo: renamed.name,
		commits: { deferred: [{ items: [{ sha: "same-sha" }] }] },
	});
	await s.seed([commit("old-identity-pending", renameLease.run)]);
	const replacement = { ...s.repo, id: "R_replacement" };
	const next = await s.start("replacement", THIRD, replacement);
	const newCommit = commit("same-sha", next.run, true);
	await s.seed([newCommit], replacement);
	expect(await readLandedActivity(s.db, next.run, replacement)).toMatchObject({
		items: [newCommit],
		deferred: [],
	});
	await s.freeze(next, replacement);
	await s.publish(next, replacement);
	expect(
		(await s.ledger()).results.find((row) => row.sha === "old-identity-pending"),
	).toMatchObject({ repo_id: s.repo.id, published_run_id: null });
	expect((await s.ledger()).results.filter((row) => row.sha === "same-sha")).toMatchObject([
		{ repo_id: s.repo.id, published_run_id: renameLease.run.id },
		{ repo_id: replacement.id, published_run_id: next.run.id },
	]);
});

it("rejects publication metadata from a replacement id instead of consuming that repository's same-sha pending row", async () => {
	const s = await setup();
	const lease = await s.start("pinned-identity", FIRST);
	const observed = commit("colliding-sha", lease.run);
	await s.seed([observed]);
	await s.freeze(lease);
	const replacement = { ...s.repo, id: "R_unrelated" };
	await s.seed([observed], replacement);
	const before = await s.ledger();
	await expect(activityPublicationWrites(s.db, lease, FIRST, [replacement])).rejects.toMatchObject({
		code: "snapshot_missing",
	});
	expect(await s.ledger()).toEqual(before);
});

it("trimming deferred commits compacts only serialized SHAs and leaves every omitted payload pending", async () => {
	const s = await setup();
	const abandoned = await s.start("deferred-window", FIRST);
	const earlier = Array.from({ length: 250 }, (_, index) => ({
		...commit(`deferred-${String(index).padStart(3, "0")}`, abandoned.run, true),
		message: "\u{1f992}".repeat(240),
		url: `https://fixture.invalid/${"x".repeat(2024)}`,
	}));
	await s.seed(earlier);
	await controlRun(s.db, ACCOUNT, abandoned.run.id, "cancel", FIRST);
	const lease = await s.start("trimmed-publication", SECOND);
	const current = Array.from({ length: 250 }, (_, index) => ({
		...commit(`current-${String(index).padStart(3, "0")}`, lease.run),
		message: "\u{1f992}".repeat(240),
		url: `https://fixture.invalid/${"x".repeat(2024)}`,
	}));
	await s.seed(current);
	const frozen = await s.freeze(lease);
	expect(new TextEncoder().encode(JSON.stringify(frozen)).length).toBeLessThanOrEqual(1_500_000);
	expect(frozen.coverage.commits).toMatchObject({ status: "partial", truncated: true });
	const packed = [
		...(frozen.commits.items ?? []),
		...(frozen.commits.deferred ?? []).flatMap((group) => group.items),
	];
	expect(frozen.commits.deferred?.[0]?.items.length).toBeGreaterThan(0);
	expect(frozen.commits.deferred?.[0]?.items.length).toBeLessThan(earlier.length);
	expect(packed.length).toBeLessThan(500);
	const saved = await s.publish(lease);
	expect(saved.repos[0]?.commits).toEqual(frozen.commits);
	const included = new Set(packed.map((item) => item.sha));
	for (const row of (await s.ledger()).results) {
		expect(row.published_run_id).toBe(included.has(row.sha) ? lease.run.id : null);
		expect(row.payload === null).toBe(included.has(row.sha));
	}
	const remaining = await readLandedActivity(s.db, lease.run, s.repo);
	expect(remaining.items.length + remaining.deferred.flatMap((group) => group.items).length).toBe(
		500 - included.size,
	);
});

it("the 500-item read cap keeps the 501st identity pending and publishes it later under its original window", async () => {
	const s = await setup();
	const lease = await s.start("capped-publication", FIRST);
	await s.seed(
		Array.from({ length: 501 }, (_, index) =>
			commit(`sha-${String(index).padStart(3, "0")}`, lease.run, true),
		),
	);
	const landed = await readLandedActivity(s.db, lease.run, s.repo);
	expect(landed.items).toHaveLength(500);
	expect(landed.items.at(-1)?.sha).toBe("sha-499");
	expect(landed.coverage).toMatchObject({ status: "partial", truncated: true });
	const frozen = await s.freeze(lease);
	expect(frozen.commits.default).toBeNull();
	expect(frozen.commits.items).toHaveLength(500);
	await s.publish(lease);
	const pending = (await s.ledger()).results.filter((row) => row.published_run_id === null);
	expect(pending).toHaveLength(1);
	expect(pending[0]).toMatchObject({
		sha: "sha-500",
		first_run_id: lease.run.id,
		payload: expect.any(String),
	});
	const next = await s.start("after-cap", SECOND);
	const deferred = await s.freeze(next);
	expect(deferred.commits).toMatchObject({
		default: 0,
		items: [],
		deferred: [
			{
				runId: lease.run.id,
				window: requireActivityWindow(lease.run),
				items: [{ sha: "sha-500", observation: { bootstrap: true } }],
			},
		],
	});
	await s.publish(next);
	expect(
		(await s.ledger()).results
			.filter((row) => row.published_run_id === next.run.id)
			.map((row) => row.sha),
	).toEqual(["sha-500"]);
	expect((await s.ledger()).results.every((row) => row.payload === null)).toBe(true);
});
