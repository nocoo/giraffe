import { expect, it } from "vitest";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { ActivityCommit } from "../../lib/activity-types";
import { makeRun } from "../../lib/factory-run";
import { landedQuota } from "./activity-landed-quota";
import { createDb } from "./db/d1";
import {
	claimRun,
	fenced,
	fencedPostcondition,
	rebindRunWrites,
	saveRun,
	startRun,
} from "./db/factory-runs";
import { mapFactoryRepo } from "./factory-map";
import { factoryStorage } from "./factory-retention";

const now = "2026-10-23T22:14:55.000Z";
const account = "account_123";
const byteLength = (value: string) => new TextEncoder().encode(value).length;

async function setup() {
	const db = createDb(sqliteFixture(), undefined, 10_000);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake',?,?)",
		)
		.bind(account, now, now)
		.run();
	const repo = mapFactoryRepo(rawRepo);
	await startRun(
		db,
		makeRun(
			"run",
			account,
			"nocoo",
			"run",
			"refresh",
			[repo],
			now,
			[],
			[repo.name],
			{
				scope: "all",
			},
			"quick",
		),
	);
	const claimed = await claimRun(db, "run", now);
	if (!claimed) throw new Error("fixture lease missing");
	const lease = claimed;
	if (!lease.run.activityWindow) throw new Error("fixture activity window missing");
	const metadata = lease.run.steps.find((step) => step.kind === "metadata");
	if (!metadata) throw new Error("fixture metadata missing");
	metadata.status = "success";
	metadata.sourceHead = "head";
	metadata.sourceBranch = "main";
	const pending = JSON.stringify({
		head: "head",
		branch: "main",
		runId: lease.run.id,
		window: lease.run.activityWindow,
		at: now,
		bootstrap: true,
		mode: "history",
		page: 1,
		accepted: 0,
	});
	async function fillAccount(bytes: number) {
		const current = await factoryStorage(db, account);
		await db
			.prepare("UPDATE factory_budget SET bytes=bytes+? WHERE account_id=?")
			.bind(bytes - current.totalBytes, account)
			.run();
	}
	function headWrite(head: string | null, checkpoint: string | null) {
		return fenced(
			db,
			lease,
			now,
			"INSERT INTO activity_commit_heads(account_id,repo_id,head,pending) SELECT ?,?,?,? WHERE $guard ON CONFLICT(account_id,repo_id) DO UPDATE SET head=excluded.head,pending=excluded.pending",
			[account, repo.id, head, checkpoint],
		);
	}
	async function savedRun() {
		return db.prepare("SELECT * FROM factory_runs WHERE id=?").bind(lease.run.id).first();
	}
	function ledgerWrite(items: ActivityCommit[], reconciliation: string) {
		return fenced(
			db,
			lease,
			now,
			"INSERT INTO activity_commit_ledger(account_id,repo_id,sha,first_run_id,observed_at,window_since,window_until,payload,reconciliation) SELECT ?,?,json_extract(value,'$.sha'),json_extract(value,'$.observation.runId'),json_extract(value,'$.observation.at'),json_extract(value,'$.observation.window.since'),json_extract(value,'$.observation.window.until'),value,? FROM json_each(?) WHERE $guard ON CONFLICT(account_id,repo_id,sha) DO UPDATE SET reconciliation=excluded.reconciliation",
			[account, repo.id, reconciliation, JSON.stringify(items)],
		);
	}
	const item: ActivityCommit = {
		sha: "sha",
		author: null,
		message: "work",
		at: now,
		url: "",
		branch: "main",
		is_default_branch: true,
		observation: {
			runId: lease.run.id,
			window: lease.run.activityWindow,
			at: now,
			bootstrap: true,
		},
	};
	return { db, lease, repo, pending, fillAccount, headWrite, savedRun, ledgerWrite, item };
}

it("rolls back the 58-byte final run payload overshoot after the quota precheck passes", async () => {
	const fixture = await setup();
	const { db, lease, repo, pending } = fixture;
	await fixture.fillAccount(512_000_000 - byteLength(account + repo.id + pending));
	const before = await fixture.savedRun();
	const storage = await factoryStorage(db, account);
	const quota = await landedQuota(db, lease, repo.id, [], null, pending, now);
	await expect(
		saveRun(db, lease, [quota, fixture.headWrite(null, pending)], now, true),
	).rejects.toMatchObject({ code: "db_error" });
	expect(await fixture.savedRun()).toEqual(before);
	expect(await factoryStorage(db, account)).toEqual(storage);
	expect((await db.prepare("SELECT * FROM activity_commit_heads").all()).results).toEqual([]);
});

it("accepts the exact final account limit and reports the run update rather than the postcondition", async () => {
	const fixture = await setup();
	const { db, lease, repo, pending } = fixture;
	await fixture.fillAccount(512_000_000 - byteLength(account + repo.id + pending) - 58);
	const version = lease.version;
	const quota = await landedQuota(db, lease, repo.id, [], null, pending, now);
	expect(await saveRun(db, lease, [quota, fixture.headWrite(null, pending)], now, true)).toBe(true);
	expect((await factoryStorage(db, account)).totalBytes).toBe(512_000_000);
	expect(lease.version).toBe(version + 1);
});

it("charges only the replacement head delta and permits a checkpoint that releases space", async () => {
	const fixture = await setup();
	const { db, lease, repo, pending } = fixture;
	expect(await saveRun(db, lease, [fixture.headWrite(null, pending)], now, true)).toBe(true);
	await fixture.fillAccount(512_000_000);
	const quota = await landedQuota(db, lease, repo.id, [], "head", null, now);
	expect(await saveRun(db, lease, [quota, fixture.headWrite("head", null)], now, true)).toBe(true);
	expect((await factoryStorage(db, account)).totalBytes).toBe(
		512_000_000 - byteLength(pending) + byteLength("head"),
	);
});

it("prechecks the UTF-8 reconciliation bytes of new identities", async () => {
	const fixture = await setup();
	const { db, lease, repo, item } = fixture;
	const reconciliation = "run@\u00e9";
	const observation = item.observation;
	if (!observation) throw new Error("fixture observation missing");
	const added = byteLength(
		account +
			repo.id +
			item.sha +
			observation.runId +
			observation.at +
			observation.window.since +
			observation.window.until +
			JSON.stringify(item) +
			reconciliation +
			account +
			repo.id +
			"head",
	);
	await fixture.fillAccount(512_000_000 - added + 1);
	await expect(
		landedQuota(db, lease, repo.id, [item], "head", null, now, reconciliation),
	).rejects.toMatchObject({ code: "factory_capacity" });
	await fixture.fillAccount(512_000_000 - added);
	await expect(
		landedQuota(db, lease, repo.id, [item], "head", null, now, reconciliation),
	).resolves.toBeDefined();
});

it("charges only reconciliation growth for existing identities and keeps their first evidence", async () => {
	const fixture = await setup();
	const { db, lease, repo, item } = fixture;
	expect(
		await saveRun(
			db,
			lease,
			[fixture.headWrite("head", null), fixture.ledgerWrite([item], "x")],
			now,
			true,
		),
	).toBe(true);
	const before = await db.prepare("SELECT * FROM activity_commit_ledger").first();
	const reconciliation = "run@\u00e9";
	const delta = byteLength(reconciliation) - byteLength("x");
	await fixture.fillAccount(512_000_000 - delta + 1);
	await expect(
		landedQuota(db, lease, repo.id, [item], "head", null, now, reconciliation),
	).rejects.toMatchObject({ code: "factory_capacity" });
	await fixture.fillAccount(512_000_000 - delta);
	const quota = await landedQuota(db, lease, repo.id, [item], "head", null, now, reconciliation);
	expect(
		await saveRun(db, lease, [quota, fixture.ledgerWrite([item], reconciliation)], now, true),
	).toBe(true);
	expect((await factoryStorage(db, account)).totalBytes).toBe(512_000_000);
	expect(await db.prepare("SELECT * FROM activity_commit_ledger").first()).toEqual({
		...before,
		reconciliation,
	});
	const shrink = await landedQuota(db, lease, repo.id, [item], "head", null, now, "");
	expect(await saveRun(db, lease, [shrink, fixture.ledgerWrite([item], "")], now, true)).toBe(true);
	expect((await factoryStorage(db, account)).totalBytes).toBe(
		512_000_000 - byteLength(reconciliation),
	);
});

it("rolls back both a ledger insertion and run update when storage changes after precheck", async () => {
	const fixture = await setup();
	const { db, lease, repo, item } = fixture;
	const quota = await landedQuota(db, lease, repo.id, [item], "head", null, now, "run@head");
	await fixture.fillAccount(512_000_000);
	const before = await fixture.savedRun();
	await expect(
		saveRun(
			db,
			lease,
			[quota, fixture.ledgerWrite([item], "run@head"), fixture.headWrite("head", null)],
			now,
			true,
		),
	).rejects.toMatchObject({ code: "db_error" });
	expect(await fixture.savedRun()).toEqual(before);
	expect((await db.prepare("SELECT * FROM activity_commit_ledger").all()).results).toEqual([]);
	expect((await db.prepare("SELECT * FROM activity_commit_heads").all()).results).toEqual([]);
	expect((await factoryStorage(db, account)).totalBytes).toBe(512_000_000);
});

it("preserves postconditions across lane rebinding and checks final status and journal", async () => {
	const fixture = await setup();
	const { db, lease } = fixture;
	const lane = { ...lease, run: structuredClone(lease.run) };
	expect(await saveRun(db, lease, [], now, true)).toBe(true);
	await db
		.prepare("UPDATE factory_run_journal SET journal=? WHERE run_id=?")
		.bind('{"held":"fixture"}', lease.run.id)
		.run();
	const postcondition = fencedPostcondition(
		db,
		lane,
		now,
		"SELECT CASE WHEN status='completed' AND version=? AND lease_token IS NULL AND (SELECT journal FROM factory_run_journal WHERE run_id=id)='{}' THEN 1 ELSE json('{') END FROM factory_runs WHERE id=?",
		[lease.version + 1, lease.run.id],
	);
	lease.run.status = "completed";
	lease.run.finishedAt = now;
	expect(await saveRun(db, lease, rebindRunWrites(db, lease, [postcondition]), now)).toBe(true);
	expect(await fixture.savedRun()).toMatchObject({ status: "completed", lease_token: null });
});

it("does not evaluate postconditions or retain writes after lease revocation", async () => {
	const fixture = await setup();
	const { db, lease } = fixture;
	const postcondition = fencedPostcondition(db, lease, now, "SELECT json('{')");
	await db
		.prepare("UPDATE factory_runs SET lease_until=? WHERE id=?")
		.bind(now, lease.run.id)
		.run();
	expect(
		await saveRun(db, lease, [postcondition, fixture.headWrite("head", null)], now, true),
	).toBe(false);
	expect((await db.prepare("SELECT * FROM activity_commit_heads").all()).results).toEqual([]);
});

it("rejects rebinding a postcondition from another lease owner", async () => {
	const { db, lease } = await setup();
	const postcondition = fencedPostcondition(db, lease, now, "SELECT 1");
	expect(() => rebindRunWrites(db, { ...lease, token: "other-owner" }, [postcondition])).toThrow(
		"factory write ownership changed",
	);
});

it("fails closed at 100000 identities without blocking existing-identity reconciliation", async () => {
	const fixture = await setup();
	const { db, lease, repo, item } = fixture;
	expect(await saveRun(db, lease, [fixture.headWrite("head", null)], now, true)).toBe(true);
	await db
		.prepare(
			"WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<100000) INSERT INTO activity_commit_ledger(account_id,repo_id,sha,first_run_id,observed_at,window_since,window_until,reconciliation) SELECT ?,?,CAST(n AS TEXT),'first','at','since','until','old' FROM ids",
		)
		.bind(account, repo.id)
		.run();
	await expect(
		landedQuota(db, lease, repo.id, [item], "head", null, now, "run@head"),
	).rejects.toMatchObject({ code: "factory_capacity" });
	const existing = { ...item, sha: "1" };
	const quota = await landedQuota(db, lease, repo.id, [existing], "head", null, now, "run@head");
	expect(
		await saveRun(db, lease, [quota, fixture.ledgerWrite([existing], "run@head")], now, true),
	).toBe(true);
	expect(await db.prepare("SELECT COUNT(*) AS count FROM activity_commit_ledger").first()).toEqual({
		count: 100000,
	});
	expect(
		await db
			.prepare(
				"SELECT first_run_id,payload,reconciliation FROM activity_commit_ledger WHERE sha='1'",
			)
			.first(),
	).toEqual({ first_run_id: "first", payload: null, reconciliation: "run@head" });
	const finalQuota = await landedQuota(db, lease, repo.id, [], "head", null, now);
	const before = await fixture.savedRun();
	await expect(
		saveRun(db, lease, [finalQuota, fixture.ledgerWrite([item], "run@head")], now, true),
	).rejects.toMatchObject({ code: "db_error" });
	expect(await fixture.savedRun()).toEqual(before);
	expect(await db.prepare("SELECT COUNT(*) AS count FROM activity_commit_ledger").first()).toEqual({
		count: 100000,
	});
});

it("enforces the exact 64 MB aggregate, including markers and replaceable checkpoints", async () => {
	const fixture = await setup();
	const { db, lease, repo, item } = fixture;
	const reconciliation = "run@\u00e9";
	const checkpoint = "pinned-checkpoint";
	expect(
		await saveRun(
			db,
			lease,
			[fixture.headWrite("head", checkpoint), fixture.ledgerWrite([item], reconciliation)],
			now,
			true,
		),
	).toBe(true);
	const ledger = await db
		.prepare("SELECT * FROM activity_commit_ledger")
		.first<Record<string, string | null>>();
	if (!ledger) throw new Error("fixture ledger missing");
	const identityBytes = Object.entries(ledger).reduce(
		(total, [key, value]) => total + (key === "payload" ? 0 : byteLength(value ?? "")),
		0,
	);
	const payloadBytes =
		64_000_000 - identityBytes - byteLength(`${account}${repo.id}head${checkpoint}`);
	await db
		.prepare("UPDATE activity_commit_ledger SET payload=CAST(zeroblob(?) AS TEXT)")
		.bind(payloadBytes)
		.run();
	const same = await landedQuota(
		db,
		lease,
		repo.id,
		[item],
		"head",
		checkpoint,
		now,
		reconciliation,
	);
	expect(
		await saveRun(
			db,
			lease,
			[same, fixture.headWrite("head", checkpoint), fixture.ledgerWrite([item], reconciliation)],
			now,
			true,
		),
	).toBe(true);
	await expect(
		landedQuota(db, lease, repo.id, [], "head", `${checkpoint}x`, now),
	).rejects.toMatchObject({ code: "factory_capacity" });
	await expect(
		landedQuota(db, lease, repo.id, [item], "head", checkpoint, now, `${reconciliation}x`),
	).rejects.toMatchObject({ code: "factory_capacity" });
	const finalQuota = await landedQuota(db, lease, repo.id, [], "head", checkpoint, now);
	const before = await fixture.savedRun();
	await expect(
		saveRun(db, lease, [finalQuota, fixture.ledgerWrite([item], `${reconciliation}x`)], now, true),
	).rejects.toMatchObject({ code: "db_error" });
	expect(await fixture.savedRun()).toEqual(before);
	expect(await db.prepare("SELECT reconciliation FROM activity_commit_ledger").first()).toEqual({
		reconciliation,
	});
	const shrink = await landedQuota(db, lease, repo.id, [], "head", null, now);
	expect(await saveRun(db, lease, [shrink, fixture.headWrite("head", null)], now, true)).toBe(true);
	expect(await db.prepare("SELECT pending FROM activity_commit_heads").first()).toEqual({
		pending: null,
	});
});
