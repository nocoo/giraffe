import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { observationVersion, savedContentMeta, storedContent } from "./content-version";
import { createDb } from "./db/d1";
import { claimRun, getRun, saveRun, startRun } from "./db/factory-runs";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { readMachineRepositoryObservation } from "./machine-observations";
import { readSources } from "./machine-sources";
import { publishSiteSnapshots } from "./site-publication";
import { splitPages } from "./snapshot-pages";

const collectedAt = "2026-10-22T04:00:00.000Z";
const publishedAt = "2026-10-22T04:00:01.000Z";

it("reserves the final timestamp width when retained collection timestamps omit milliseconds", async () => {
	const db = createDb(sqliteFixture());
	const shortTime = "2026-10-22T04:00:00Z";
	const overhead = new TextEncoder().encode(
		JSON.stringify({
			items: [{ name: "" }],
			truncated: false,
			fetched_at: shortTime,
			publication: { runId: "ready", publishedAt: shortTime },
		}),
	).length;
	const item = { name: "x".repeat(1_500_000 - overhead) };
	await expect(
		replaceSnapshotStmts(
			db,
			"account",
			"issues",
			{ items: [item, item], truncated: false },
			shortTime,
			"ready",
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
	expect(db.statements).toBe(0);
});

async function stagedFixture(pageCount = 1, observedAt = collectedAt) {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','owner','encrypted','fake',?,?)",
		)
		.bind(collectedAt, collectedAt)
		.run();
	await startRun(db, makeRun("ready", "account", "owner", "ready", "refresh", [], collectedAt));
	const lease = await claimRun(db, "ready", collectedAt);
	if (!lease) throw new Error("fixture lease missing");
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			"repos",
			{ repos: [{ name_with_owner: "owner/app" }] },
			collectedAt,
		),
	);
	const resource = "repo:owner/app:actions";
	await db.batch(
		await replaceSnapshotStmts(
			db,
			"account",
			resource,
			{
				runs: Array.from({ length: pageCount }, (_, index) => ({
					id: index,
					name: "x".repeat(pageCount === 2 ? 800_000 : 1),
					created_at: collectedAt,
					updated_at: collectedAt,
					status: "completed",
					conclusion: "success",
				})),
				truncated: false,
			},
			observedAt,
			"ready",
		),
	);
	return { raw, db, lease, resource };
}

it.each([1, 2])(
	"shares composite publication versions with sources for %s physical pages",
	async (pageCount) => {
		const { raw, db, lease, resource } = await stagedFixture(pageCount);
		const before = await raw
			.prepare("SELECT content_meta FROM factory_resources WHERE stream=?")
			.bind(`site:${resource}`)
			.first<{ content_meta: string }>();
		const staged = JSON.parse(before?.content_meta ?? "{}");
		const originalCatalog = await raw
			.prepare("SELECT payload,content_meta FROM snapshots WHERE kind='repos'")
			.first();
		const writes = await publishSiteSnapshots(db, lease, publishedAt);
		lease.run.status = "completed";
		lease.run.publishedAt = publishedAt;
		expect(await saveRun(db, lease, writes, publishedAt)).toBe(true);
		const expected = await observationVersion({
			snapshot: staged.fullVersion,
			publication: { runId: "ready", publishedAt },
		});
		const observation = await readMachineRepositoryObservation(
			createDb(raw),
			"account",
			"owner/app",
			"actions",
		);
		expect(observation.sourceVersion).toBe(expected);
		expect(observation.contentVersion).toBe(staged.hash);
		const sourcesDb = createDb(raw);
		const sources = await readSources(sourcesDb, "account", {});
		expect(sourcesDb.statements).toBe(7);
		expect(sources.sources.find((source) => source.resource === resource)).toMatchObject({
			version: expected,
			contentVersion: staged.hash,
			runId: "ready",
			fetchedAt: publishedAt,
			observedAt: collectedAt,
		});
		const pages = await raw
			.prepare("SELECT content_meta FROM snapshots WHERE kind IN (?,?)")
			.bind(resource, `${resource}#2`)
			.all<{ content_meta: string }>();
		expect(pages.results).toHaveLength(pageCount);
		for (const page of pages.results)
			expect(JSON.parse(page.content_meta)).toEqual({ hash: staged.hash, fullVersion: expected });
		expect(
			await raw.prepare("SELECT payload,content_meta FROM snapshots WHERE kind='repos'").first(),
		).toEqual(originalCatalog);
	},
);

it("changes observation versions but not content for collection or publication time", async () => {
	const versions = [];
	for (const [observedAt, visibleAt] of [
		[collectedAt, publishedAt],
		[publishedAt, publishedAt],
		[collectedAt, "2026-10-22T04:00:02.000Z"],
	]) {
		const { db, lease, resource } = await stagedFixture(1, observedAt);
		await db.batch(await publishSiteSnapshots(db, lease, visibleAt as string));
		versions.push(storedContent(await readSnapshot(db, "account", resource)));
	}
	expect(new Set(versions.map((version) => version?.fullVersion)).size).toBe(3);
	expect(new Set(versions.map((version) => version?.hash)).size).toBe(1);
});

it.each([
	"missing",
	"malformed",
	"null",
	"empty",
	"invalid-hash",
	"invalid-version",
	"orphan",
	"disagreement",
])("rejects %s staged metadata before any promotion", async (failure) => {
	const { raw, db, lease, resource } = await stagedFixture();
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	if (failure === "orphan")
		await raw.prepare("UPDATE factory_resources SET stream=stream||'#2'").run();
	else if (failure === "disagreement")
		await raw
			.prepare(
				"INSERT INTO factory_resources SELECT run_id,repo,stream||'#2',payload,json_set(content_meta,'$.fullVersion',?) FROM factory_resources",
			)
			.bind(`sha256:${"a".repeat(64)}`)
			.run();
	else {
		const valid = { hash: `sha256:${"a".repeat(64)}`, fullVersion: `sha256:${"b".repeat(64)}` };
		const values: Record<string, string | null> = {
			missing: null,
			malformed: "{",
			null: "null",
			empty: "{}",
			"invalid-hash": JSON.stringify({ ...valid, hash: "invalid" }),
			"invalid-version": JSON.stringify({ ...valid, fullVersion: "invalid" }),
		};
		await raw
			.prepare("UPDATE factory_resources SET content_meta=? WHERE stream=?")
			.bind(values[failure], `site:${resource}`)
			.run();
	}
	await expect(publishSiteSnapshots(db, lease, publishedAt)).rejects.toMatchObject({
		code: "snapshot_metadata_invalid",
	});
	expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
	expect((await getRun(db, "account", "ready"))?.run.publishedAt).toBeNull();
});

it("prepares 500 repositories with nine tabs within the unchanged statement budget", async () => {
	const { raw, db, lease } = await stagedFixture();
	await raw
		.prepare(
			"WITH RECURSIVE tabs(number) AS (SELECT 1 UNION ALL SELECT number+1 FROM tabs WHERE number<4500) INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) SELECT 'ready','','site:repo:owner/large'||number||':actions',source.payload,source.content_meta FROM tabs CROSS JOIN factory_resources source WHERE source.stream='site:repo:owner/app:actions'",
		)
		.run();
	const priorStatements = db.statements;
	const writes = await publishSiteSnapshots(db, lease, publishedAt);
	expect(db.statements - priorStatements).toBe(1);
	expect(writes).toHaveLength(2);
	lease.run.status = "completed";
	lease.run.publishedAt = publishedAt;
	expect(await saveRun(db, lease, writes, publishedAt)).toBe(true);
	expect(
		await raw.prepare("SELECT count(*) AS total FROM snapshots WHERE kind LIKE 'repo:%'").first(),
	).toEqual({ total: 4501 });
});

it("prepares 50 two-page publications without loading staged payloads and commits atomically", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','owner','encrypted','fake',?,?)",
		)
		.bind(collectedAt, collectedAt)
		.run();
	await startRun(db, makeRun("ready", "account", "owner", "ready", "refresh", [], collectedAt));
	const lease = await claimRun(db, "ready", collectedAt);
	if (!lease) throw new Error("fixture lease missing");
	const data = {
		items: [{ title: "x".repeat(1_499_800) }, { title: "y".repeat(1_499_800) }],
		fetched_at: collectedAt,
		truncated: false,
		publication: { runId: "ready", publishedAt: collectedAt },
	};
	const { pages, capacityExceeded } = splitPages("issues", data);
	expect(capacityExceeded).toBe(false);
	expect(pages).toHaveLength(2);
	const metadata = await savedContentMeta("issues", data);
	for (const [index, page] of pages.entries())
		await raw
			.prepare(
				"WITH RECURSIVE repos(number) AS (SELECT 1 UNION ALL SELECT number+1 FROM repos WHERE number<50) INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) SELECT 'ready','','site:repo:owner/app'||number||':issues'||?,?,? FROM repos",
			)
			.bind(index ? "#2" : "", page.payload, metadata)
			.run();
	await raw
		.prepare(
			"WITH RECURSIVE repos(number) AS (SELECT 1 UNION ALL SELECT number+1 FROM repos WHERE number<50) INSERT INTO snapshots(account_id,kind,payload,fetched_at) SELECT 'account','repo:owner/app'||number||':issues','{\"items\":[\"prior\"]}','old' FROM repos",
		)
		.run();
	const prepare = db.prepare.bind(db);
	const reads = vi.spyOn(db, "prepare").mockImplementation((query) => {
		if (/^SELECT/i.test(query) && /factory_resources/.test(query))
			expect(query).not.toMatch(/\bpayload\b/);
		return prepare(query);
	});
	const writes = await publishSiteSnapshots(db, lease, publishedAt);
	expect(writes).toHaveLength(2);
	expect(reads.mock.calls.filter(([query]) => /^SELECT/i.test(query))).toHaveLength(1);
	expect(db.statements).toBeLessThan(10);
	const prior = await raw
		.prepare("SELECT count(*) AS total FROM snapshots WHERE fetched_at='old'")
		.first();
	expect(prior).toEqual({ total: 50 });
	expect((await getRun(db, "account", "ready"))?.run.publishedAt).toBeNull();
	lease.run.status = "completed";
	lease.run.publishedAt = publishedAt;
	await expect(
		saveRun(db, lease, [...writes, db.prepare("SELECT json('{')")], publishedAt),
	).rejects.toMatchObject({ code: "db_error" });
	expect(
		await raw.prepare("SELECT count(*) AS total FROM snapshots WHERE fetched_at='old'").first(),
	).toEqual(prior);
	expect((await getRun(db, "account", "ready"))?.run.publishedAt).toBeNull();
	expect(await saveRun(db, lease, writes, publishedAt)).toBe(true);
	expect((await getRun(db, "account", "ready"))?.run.publishedAt).toBe(publishedAt);
	expect(await raw.prepare("SELECT count(*) AS total FROM snapshots").first()).toEqual({
		total: 100,
	});
	const saved = await readSnapshot(db, "account", "repo:owner/app50:issues");
	expect(saved).toMatchObject({
		items: data.items,
		fetched_at: collectedAt,
		truncated: false,
		publication: { runId: "ready", publishedAt },
	});
});
