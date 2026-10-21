import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";
import { factoryFreshness, repoPolicy } from "./repo-statistics";

async function fixture() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const publication = factoryFixture();
	const account = publication.account_id;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(account)
		.run();
	const repo = publication.repos[0];
	if (!repo) throw new Error("fixture");
	repo.observation = {
		version: "saved",
		refreshedAt: publication.fetched_at,
		metadataAt: publication.fetched_at,
		window: publication.window,
		source: "run",
	};
	publication.repos.push(
		{
			...repo,
			name: "nocoo/archived",
			is_archived: true,
			observation: { ...repo.observation, refreshedAt: "2026-09-01T00:00:00Z" },
		},
		{
			...repo,
			name: "nocoo/fork",
			is_fork: true,
			observation: { ...repo.observation, refreshedAt: "2026-09-02T00:00:00Z" },
		},
		{ ...repo, name: "nocoo/removed" },
	);
	const save = async (kind: string, data: Record<string, unknown>) =>
		db.batch(await replaceSnapshotStmts(db, account, kind, data, publication.fetched_at));
	await save("repos", {
		repos: [
			{ name_with_owner: "NOCOO/APP" },
			{ name_with_owner: "external/not-owned" },
			{ name_with_owner: "nocoo/archived", is_archived: true },
			{ name_with_owner: "nocoo/fork", is_fork: true },
		],
	});
	await save("factory", publication);
	return { raw, db, account, publication, repo, save };
}

it("counts only enabled published repositories without changing visible lists or stored evidence", async () => {
	const { raw, db, account, publication } = await fixture();
	const before = (await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results;
	const fetchSpy = vi.spyOn(globalThis, "fetch");
	try {
		const expected = {
			oldestAt: publication.fetched_at,
			latestAt: publication.fetched_at,
			total: 1,
			missing: 0,
		};
		expect(factoryFreshness(publication, await repoPolicy(db, account))).toEqual(expected);
		const envelope = await readObservation(db, account, "factory", "all");
		expect(envelope).toMatchObject({ freshness: expected, truncated: false });
		expect(envelope.data.repos).toHaveLength(3);
		expect(envelope.selection.statisticsFilter).toBe(false);
		const reader = createDb(raw);
		const index = await readSources(reader, account, {});
		expect(reader.statements).toBe(5);
		expect(index.sources.find((s) => s.resource === "account:factory")).toMatchObject({
			freshness: expected,
			truncated: false,
			contentVersion: envelope.contentVersion,
		});
		expect((await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results).toEqual(
			before,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	} finally {
		fetchSpy.mockRestore();
	}
});

it("counts missing owned observations and marks incomplete inventory truncated", async () => {
	const { raw, db, account, publication, repo, save } = await fixture();
	delete repo.observation;
	publication.inventory.complete = false;
	await save("factory", publication);
	const envelope = await readObservation(db, account, "factory", "all");
	expect(envelope).toMatchObject({
		freshness: { oldestAt: null, latestAt: null, total: 1, missing: 1 },
		fetchedAt: "",
		truncated: true,
		data: { truncated: true },
	});
	expect(
		(await readSources(createDb(raw), account, {})).sources.find(
			(s) => s.resource === "account:factory",
		),
	).toMatchObject({
		freshness: envelope.freshness,
		truncated: true,
		contentVersion: envelope.contentVersion,
	});
});

it("includes enabled identities in hashes even when freshness counts do not change", async () => {
	const { raw, db, account, publication } = await fixture();
	const first = await readObservation(db, account, "factory", "all");
	expect(first.contentVersion).toMatch(/^sha256:/);
	await db
		.prepare(
			"INSERT INTO repo_statistics(account_id,repo,enabled) VALUES(?,'nocoo/app',0),(?,'nocoo/archived',1)",
		)
		.bind(account, account)
		.run();
	const second = await readObservation(db, account, "factory", "all");
	expect(first.freshness).toMatchObject({ total: 1, missing: 0 });
	expect(second.freshness).toMatchObject({ total: 1, missing: 0 });
	expect(second.data.repos).toEqual(first.data.repos);
	expect(second.contentVersion).not.toBe(first.contentVersion);
	expect(
		(await readSources(createDb(raw), account, {})).sources.find(
			(s) => s.resource === "account:factory",
		)?.contentVersion,
	).toBe(second.contentVersion);
	await db
		.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,'nocoo/app')")
		.bind(account)
		.run();
	const starred = await readObservation(db, account, "factory", "starred");
	expect(starred.freshness).toEqual({ oldestAt: null, latestAt: null, total: 0, missing: 0 });
	expect(starred.contentVersion).not.toBe(second.contentVersion);
	expect(publication.repos).toHaveLength(4);
});

it("preserves stored truncation independently of complete inventory", async () => {
	const { raw, db, account, publication, save } = await fixture();
	const complete = await readObservation(db, account, "factory", "all");
	await save("factory", { ...publication, truncated: true });
	const truncated = await readObservation(db, account, "factory", "all");
	expect(truncated).toMatchObject({
		truncated: true,
		freshness: { total: 1, missing: 0 },
		data: { truncated: true, inventory: { complete: true } },
	});
	expect(truncated.contentVersion).not.toBe(complete.contentVersion);
	expect(
		(await readSources(createDb(raw), account, {})).sources.find(
			(source) => source.resource === "account:factory",
		),
	).toMatchObject({ truncated: true, contentVersion: truncated.contentVersion });
});
