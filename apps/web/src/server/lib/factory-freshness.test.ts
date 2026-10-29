import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { savedObservationStmts as replaceSnapshotStmts } from "../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { createDb } from "./db/d1";
import { readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";
import { factoryFreshness, repoPolicy } from "./snapshot-projection";

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
			id: "R_ARCHIVED",
			name: "nocoo/archived",
			is_archived: true,
			observation: { ...repo.observation, refreshedAt: "2026-09-01T00:00:00Z" },
		},
		{
			...repo,
			id: "R_FORK",
			name: "nocoo/fork",
			is_fork: true,
			observation: { ...repo.observation, refreshedAt: "2026-09-02T00:00:00Z" },
		},
		{ ...repo, id: "R_REMOVED", name: "nocoo/removed" },
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

it("counts every owned published repository without changing visible lists or stored evidence", async () => {
	const { raw, db, account, publication } = await fixture();
	const before = (await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).results;
	const fetchSpy = vi.spyOn(globalThis, "fetch");
	try {
		const expected = {
			oldestAt: "2026-09-01T00:00:00Z",
			latestAt: publication.fetched_at,
			total: 3,
			missing: 0,
		};
		expect(factoryFreshness(publication, await repoPolicy(db, account))).toEqual(expected);
		const envelope = await readObservation(db, account, "factory", "all");
		expect(envelope).toMatchObject({ freshness: expected, truncated: false });
		expect(envelope.data.repos).toHaveLength(3);
		expect(envelope.selection.statisticsFilter).toBe(false);
		const reader = createDb(raw);
		const index = await readSources(reader, account, {});
		expect(reader.statements).toBe(7);
		expect(index.sources.find((s) => s.resource === "account:factory")).toMatchObject({
			freshness: expected,
			truncated: false,
			contentVersion: envelope.contentVersion,
		});
		expect(
			(await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).results,
		).toEqual(before);
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
		freshness: {
			oldestAt: "2026-09-01T00:00:00Z",
			latestAt: "2026-09-02T00:00:00Z",
			total: 3,
			missing: 1,
		},
		fetchedAt: "2026-09-02T00:00:00Z",
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

it("ignores legacy overrides and includes selected star identities in content hashes", async () => {
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
	expect(first.freshness).toMatchObject({ total: 3, missing: 0 });
	expect(second.freshness).toMatchObject({ total: 3, missing: 0 });
	expect(second.data.repos).toEqual(first.data.repos);
	expect(second.contentVersion).toBe(first.contentVersion);
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
	expect(starred.freshness).toEqual({
		oldestAt: publication.fetched_at,
		latestAt: publication.fetched_at,
		total: 1,
		missing: 0,
	});
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
		freshness: { total: 3, missing: 0 },
		data: { truncated: true, inventory: { complete: true } },
	});
	expect(truncated.contentVersion).not.toBe(complete.contentVersion);
	expect(
		(await readSources(createDb(raw), account, {})).sources.find(
			(source) => source.resource === "account:factory",
		),
	).toMatchObject({ truncated: true, contentVersion: truncated.contentVersion });
});

it("preserves per-stream evidence ages in both factory envelopes and source indexes with repository denominators", async () => {
	const { raw, db, account, publication, repo, save } = await fixture();
	const old = "2026-08-01T00:00:00.000Z";
	const fetched = "2026-09-15T21:00:00.000Z";
	if (!repo.observation) throw new Error("Missing observation");
	repo.coverage = structuredClone(repo.coverage);
	for (const stream of FACTORY_STREAMS) repo.coverage[stream].fetchedAt = fetched;
	repo.coverage.commits = {
		...repo.coverage.commits,
		status: "complete",
		retained: true,
		fetchedAt: old,
		observation: {
			...repo.observation,
			version: "retained",
			refreshedAt: old,
			window: { since: "2026-05-01T00:00:00.000Z", until: old },
			head: "old-head",
		},
	};
	await save("factory", publication);
	await save("repos", {
		repos: [{ name_with_owner: repo.name }, { name_with_owner: "nocoo/missing" }],
	});
	const before = (await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).results;
	const expected = { oldestAt: old, latestAt: fetched, total: 2, missing: 1 };
	expect(factoryFreshness(publication, await repoPolicy(db, account))).toEqual(expected);
	const envelope = await readObservation(db, account, "factory", "all");
	expect(envelope).toMatchObject({ freshness: expected, fetchedAt: fetched });
	const index = await readSources(createDb(raw), account, {});
	expect(index.sources.find((source) => source.resource === "account:factory")).toMatchObject({
		freshness: expected,
		contentVersion: envelope.contentVersion,
	});
	expect(
		(await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).results,
	).toEqual(before);
});
