import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { createDb } from "./db/d1";
import { claimRun, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { publicationWrites, repositoryWrites } from "./factory-publish";
import {
	FACTORY_STORAGE_SQL,
	factoryStorage,
	factoryStorageStatement,
	pruneFactory,
} from "./factory-retention";

const snap = factoryFixture();
const account = snap.account_id;
async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(account, "nocoo", "encrypted", "fake", snap.fetched_at, snap.fetched_at)
		.run();
	return { raw, db };
}
it("R7 storage accounting stays within D1 compound-select limits in one query", async () => {
	const { raw } = await setup();
	const prepare = raw.prepare.bind(raw);
	const queries: string[] = [];
	raw.prepare = (query) => {
		queries.push(query);
		if ((query.match(/UNION ALL/g) ?? []).length > 4)
			throw new Error("too many terms in compound SELECT");
		return prepare(query);
	};
	expect(await factoryStorage(createDb(raw), account)).toEqual({
		resourceBytes: 0,
		totalBytes: 0,
	});
	expect(queries).toHaveLength(1);
});
it("records publication roots atomically and protects mixed-version detail when pruning old runs", async () => {
	const { raw, db } = await setup();
	await db.batch(await replaceSnapshotStmts(db, account, "factory", { ...snap }, snap.fetched_at));
	const run = makeRun("root-run", account, "nocoo", "key", "refresh", snap.repos, snap.fetched_at);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, snap.fetched_at);
	if (!lease) throw new Error("fixture");
	const repo = structuredClone(snap.repos[0]);
	if (!repo) throw new Error("fixture");
	repo.observation = {
		source: "run",
		version: run.id,
		refreshedAt: snap.fetched_at,
		window: snap.window,
	};
	await db.batch(await repositoryWrites(db, lease, snap.fetched_at, repo, repo.name, null));
	await db.batch(await publicationWrites(db, lease, snap.fetched_at));
	const refs = await db.prepare("SELECT * FROM factory_version_refs").all();
	expect(refs.results).toHaveLength(1);
	await db
		.prepare("UPDATE factory_runs SET status='completed',created_at='2000-01-01' WHERE id=?")
		.bind(run.id)
		.run();
	await db
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
		.bind(run.id, repo.name, "commits", "{}")
		.run();
	for (let i = 0; i < 24; i++) {
		const item = makeRun(
			`old-${i}`,
			account,
			"nocoo",
			`key-${i}`,
			"catalog",
			[],
			`2010-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
		);
		item.status = "cancelled";
		await createDb(raw)
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.bind(
				item.id,
				account,
				item.requestKey,
				"cancelled",
				JSON.stringify(item),
				item.startedAt,
				item.startedAt,
				item.startedAt,
			)
			.run();
		const rowDb = createDb(raw);
		await rowDb.batch(
			await replaceSnapshotStmts(
				rowDb,
				account,
				`factory:v:${item.id}`,
				{ ...snap, runId: item.id },
				item.startedAt,
			),
		);
		await createDb(raw)
			.prepare("INSERT INTO factory_version_refs VALUES(?,?,?,?,?)")
			.bind(account, item.id, repo.name, item.id, "run")
			.run();
		await createDb(raw)
			.prepare("INSERT INTO factory_repo_versions VALUES(?,?,?,?,?)")
			.bind(account, repo.name, item.id, JSON.stringify(repo), item.startedAt)
			.run();
		await createDb(raw)
			.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
			.bind(item.id, repo.name, "commits", "{}")
			.run();
	}
	await createDb(raw)
		.prepare("DELETE FROM factory_repo_state WHERE account_id=?")
		.bind(account)
		.run();
	expect((await factoryStorage(createDb(raw), account)).resourceBytes).toBe(50);
	await pruneFactory(createDb(raw), "2026-09-16T00:00:00.000Z");
	expect(
		(
			await createDb(raw)
				.prepare("SELECT run_id FROM factory_resources WHERE run_id=?")
				.bind(run.id)
				.all()
		).results,
	).toHaveLength(1);
	expect((await factoryStorage(createDb(raw), account)).resourceBytes).toBe(42);
	expect(await readSnapshot(createDb(raw), account, "factory")).toMatchObject({
		runId: snap.runId,
	});
	expect(await readSnapshot(createDb(raw), account, "factory:v:root-run")).not.toBeNull();
});
it("reports storage telemetry without imposing an account quota", async () => {
	const { db } = await setup();
	expect(await factoryStorage(db, account)).toEqual({
		resourceBytes: 0,
		totalBytes: 0,
	});
	const run = makeRun("r", account, "nocoo", "k", "catalog", [], snap.fetched_at);
	await startRun(db, run);
	await db
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
		.bind("r", "repo", "commits", "{}")
		.run();
	await db.prepare("UPDATE factory_resources SET payload=?").bind('{"x":1}').run();
	expect((await factoryStorage(db, account)).resourceBytes).toBe(7);
	await db.prepare("UPDATE factory_budget SET bytes=512000000").run();
	expect((await factoryStorage(db, account)).totalBytes).toBe(512000000);
	expect(await factoryStorage(db, account)).not.toHaveProperty("limitBytes");
});

it("includes all page snapshots and daily baselines in the same account storage budget", async () => {
	const { db } = await setup();
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"issues",
			{ issues: [], truncated: false },
			snap.fetched_at,
		),
	);
	await db
		.prepare("INSERT INTO snapshot_days(account_id,day,payload) VALUES(?,?,?)")
		.bind(account, "2026-09-15", "{}")
		.run();
	const stored = await db
		.prepare("SELECT SUM(length(CAST(payload AS BLOB))) AS bytes FROM snapshots WHERE account_id=?")
		.bind(account)
		.first<{ bytes: number }>();
	expect((await factoryStorage(db, account)).totalBytes).toBe((stored?.bytes ?? 0) + 2);
});

it("preserves historical cloud reports and diagnostics in retention and storage accounting", async () => {
	const { db } = await setup();
	const input = '{"pending":true}';
	const report = '{"saved":true}';
	const diagnostic = '{"stage":"summary"}';
	await db
		.prepare(
			"INSERT INTO ai_reviews(account_id,repo,job_id,source_version,source_at,stage,input,report,next_at) VALUES(?,'nocoo/app','old-job','old-source',?,'summary',?,?,?)",
		)
		.bind(account, snap.fetched_at, input, report, snap.fetched_at)
		.run();
	await db
		.prepare(
			"INSERT INTO ai_review_attempts(job_id,stage,attempt,source_version,error,diagnostic,recorded_at) VALUES('old-job','summary',1,'old-source','ai_error',?,?)",
		)
		.bind(diagnostic, snap.fetched_at)
		.run();
	const review = await db.prepare("SELECT * FROM ai_reviews").all();
	const attempts = await db.prepare("SELECT * FROM ai_review_attempts").all();
	await pruneFactory(db, "2026-10-02T00:00:00.000Z");
	expect(await db.prepare("SELECT * FROM ai_reviews").all()).toEqual(review);
	expect(await db.prepare("SELECT * FROM ai_review_attempts").all()).toEqual(attempts);
	expect(await factoryStorage(db, account)).toEqual({
		resourceBytes: 0,
		totalBytes: new TextEncoder().encode(input + report + diagnostic).length,
	});
});

const ledgerRepo = "R_fixture";
async function addLedgerAccount(db: ReturnType<typeof createDb>, id: string) {
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?, 'fake-envelope','fake','old','old')",
		)
		.bind(id, id)
		.run();
}
async function addLedgerIdentity(
	db: ReturnType<typeof createDb>,
	identityAccount: string,
	sha: string,
	firstRun = "absent-run",
	publication: string | null = null,
) {
	await db
		.prepare("INSERT INTO activity_commit_ledger VALUES(?,?,?,?,?,?,?,?,?,'')")
		.bind(
			identityAccount,
			ledgerRepo,
			sha,
			firstRun,
			"observed",
			"since",
			"until",
			null,
			publication,
		)
		.run();
}

it("exports the exact 14-parameter account total query for a transaction-time quota guard", async () => {
	const { raw, db } = await setup();
	const prepare = raw.prepare.bind(raw);
	const queries: string[] = [];
	raw.prepare = (query) => {
		queries.push(query);
		return prepare(query);
	};
	await factoryStorageStatement(db, account).first();
	expect(queries).toEqual([FACTORY_STORAGE_SQL]);
	expect(FACTORY_STORAGE_SQL.match(/\?/g)).toHaveLength(14);
	await db
		.prepare("INSERT INTO activity_commit_heads VALUES(?,?,?,?)")
		.bind(account, ledgerRepo, "fixture-head", '{"cursor":"fake"}')
		.run();
	await addLedgerIdentity(db, account, "fixture-sha");
	const total = await factoryStorage(db, account);
	expect(total.totalBytes).toBeGreaterThan(0);
	expect(await db.prepare(FACTORY_STORAGE_SQL.replaceAll("?", "?1")).bind(account).first()).toEqual(
		total,
	);
});

it("counts every UTF8 head, pending, ledger identity, metadata and payload byte only for its account", async () => {
	const { db } = await setup();
	const other = "other-\u{1f992}";
	await addLedgerAccount(db, other);
	const heads = [
		[account, "R_\u96ea", "head-\u{1f992}", '{"cursor":"\u96ea\u{1f992}"}'],
		[account, "R_null", null, null],
	];
	const identities = [
		[
			account,
			"R_\u96ea",
			"sha-\u{1f992}",
			"first-\u96ea",
			"observed-\u96ea",
			"since-\u96ea",
			"until-\u96ea",
			'{"message":"\u{1f992}"}',
			null,
			"reconciliation-\u{1f992}",
		],
		[
			account,
			"R_null",
			"null-sha",
			"first",
			"observed",
			"since",
			"until",
			null,
			"published-\u96ea",
			"",
		],
	];
	for (const row of heads)
		await db
			.prepare("INSERT INTO activity_commit_heads VALUES(?,?,?,?)")
			.bind(...row)
			.run();
	for (const row of identities)
		await db
			.prepare("INSERT INTO activity_commit_ledger VALUES(?,?,?,?,?,?,?,?,?,?)")
			.bind(...row)
			.run();
	await db
		.prepare("INSERT INTO activity_commit_heads VALUES(?,?,?,?)")
		.bind(other, "R_other", "other-head", "other-pending")
		.run();
	await addLedgerIdentity(db, other, "other-sha");
	const expectedBytes = new TextEncoder().encode([...heads, ...identities].flat().join("")).length;
	expect(await factoryStorage(db, account)).toEqual({
		resourceBytes: 0,
		totalBytes: expectedBytes,
	});
	expect(await factoryStorage(db, other)).toEqual({
		resourceBytes: 0,
		totalBytes: new TextEncoder().encode(
			[
				other,
				"R_other",
				"other-head",
				"other-pending",
				other,
				ledgerRepo,
				"other-sha",
				"absent-run",
				"observed",
				"since",
				"until",
			].join(""),
		).length,
	});
	expect(await db.prepare("SELECT * FROM factory_budget").all()).toMatchObject({ results: [] });
	expect(await db.prepare("SELECT * FROM factory_storage").all()).toMatchObject({ results: [] });
	await db
		.prepare(
			"UPDATE activity_commit_heads SET head=NULL,pending=NULL WHERE account_id=? AND repo_id=?",
		)
		.bind(account, "R_\u96ea")
		.run();
	await db
		.prepare(
			"UPDATE activity_commit_ledger SET payload=NULL,published_run_id=? WHERE account_id=? AND repo_id=?",
		)
		.bind("published", account, "R_\u96ea")
		.run();
	const released = new TextEncoder().encode(
		"head-\u{1f992}" + '{"cursor":"\u96ea\u{1f992}"}' + '{"message":"\u{1f992}"}',
	).length;
	expect((await factoryStorage(db, account)).totalBytes).toBe(
		expectedBytes - released + "published".length,
	);
});

it("keeps first-observation identities and heads across run pruning and isolates account deletion", async () => {
	const { raw, db } = await setup();
	await addLedgerAccount(db, "other");
	for (const id of [account, "other"]) {
		await db
			.prepare("INSERT INTO activity_commit_heads VALUES(?,?,?,?)")
			.bind(id, ledgerRepo, "observed-head", '{"resume":"fake"}')
			.run();
		await addLedgerIdentity(db, id, "published-sha", "old-run", "old-run");
		await addLedgerIdentity(db, id, "pending-sha", "old-run");
		await addLedgerIdentity(db, id, "compacted-sha", "old-run", "old-run");
	}
	await db
		.prepare("UPDATE activity_commit_ledger SET payload=? WHERE sha='pending-sha'")
		.bind('{"fake":"pending"}')
		.run();
	await expect(addLedgerIdentity(db, account, "published-sha")).rejects.toMatchObject({
		code: "db_error",
	});
	await db
		.prepare(
			"INSERT INTO activity_commit_ledger SELECT account_id,'R_distinct',sha,first_run_id,observed_at,window_since,window_until,payload,published_run_id,reconciliation FROM activity_commit_ledger WHERE account_id=? AND sha='published-sha'",
		)
		.bind(account)
		.run();
	for (let i = 0; i < 23; i++) {
		await createDb(raw)
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'completed','{}','old',?,'old')",
			)
			.bind(
				i === 0 ? "old-run" : `recent-${i}`,
				account,
				`fixture-${i}`,
				`2020-01-${String(i + 1).padStart(2, "0")}`,
			)
			.run();
	}
	const heads = await db
		.prepare("SELECT * FROM activity_commit_heads ORDER BY account_id,repo_id")
		.all();
	const identities = await db
		.prepare("SELECT * FROM activity_commit_ledger ORDER BY account_id,repo_id,sha")
		.all();
	const bytesBefore = (await factoryStorage(db, account)).totalBytes;
	await pruneFactory(db, "2026-10-24T00:00:00.000Z");
	expect(await db.prepare("SELECT id FROM factory_runs WHERE id='old-run'").first()).toBeNull();
	expect(await db.prepare("SELECT COUNT(*) AS n FROM factory_runs").first()).toEqual({ n: 20 });
	expect(
		await db.prepare("SELECT * FROM activity_commit_heads ORDER BY account_id,repo_id").all(),
	).toEqual(heads);
	expect(
		await db.prepare("SELECT * FROM activity_commit_ledger ORDER BY account_id,repo_id,sha").all(),
	).toEqual(identities);
	expect((await factoryStorage(db, account)).totalBytes).toBe(bytesBefore - 3 * "{}".length);
	const otherBytes = await factoryStorage(db, "other");
	await db.prepare("DELETE FROM accounts WHERE id=?").bind(account).run();
	expect(await factoryStorage(db, account)).toEqual({ resourceBytes: 0, totalBytes: 0 });
	expect(await db.prepare("SELECT COUNT(*) AS n FROM activity_commit_heads").first()).toEqual({
		n: 1,
	});
	expect(await db.prepare("SELECT COUNT(*) AS n FROM activity_commit_ledger").first()).toEqual({
		n: 3,
	});
	expect(await factoryStorage(db, "other")).toEqual(otherBytes);
});
