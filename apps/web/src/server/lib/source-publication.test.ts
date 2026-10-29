import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { syncSavedObservation } from "../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import { readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";

const account = "source-publication";
const repository = "owner/app";
const collected = "2026-10-22T04:00:00.000Z";
const published = "2026-10-22T05:00:00.000Z";
const later = "2026-10-22T06:00:00.000Z";
const between = "2026-10-22T04:30:00.000Z";
const publication = { runId: "R1", publishedAt: published };

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'owner','encrypted','fake',?,?)",
		)
		.bind(account, collected, collected)
		.run();
	const save = async (kind: string, fields: Record<string, unknown>) => {
		const data = { fetched_at: collected, truncated: false, ...fields };
		await raw
			.prepare(
				"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,content_meta=excluded.content_meta",
			)
			.bind(account, kind, JSON.stringify(data), collected, await savedContentMeta(kind, data))
			.run();
		await syncSavedObservation(createDb(raw), account, kind, collected);
	};
	await save("repos", { repos: [{ name_with_owner: repository }], publication });
	for (const [kind, fields] of [
		["issues", { issues: [] }],
		["prs", { pull_requests: [] }],
		[`repo:${repository}:issues`, { issues: [] }],
		[`repo:${repository}:prs`, { pull_requests: [] }],
		[`repo:${repository}:actions`, { runs: [] }],
		[`repo:${repository}:releases`, { releases: [] }],
		[`repo:${repository}:details`, { default_branch: "main" }],
	] as const)
		await save(kind, { ...fields, publication });
	const snapshot = factoryFixture();
	snapshot.account_id = account;
	snapshot.runId = "R1";
	snapshot.owner = "owner";
	snapshot.fetched_at = collected;
	snapshot.publication = { ...publication, mixed: false };
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("missing repository fixture");
	repo.name = repository;
	const observation = {
		version: "R1",
		refreshedAt: collected,
		publishedAt: published,
		source: "run" as const,
		window: snapshot.window,
	};
	repo.observation = observation;
	for (const stream of FACTORY_STREAMS)
		repo.coverage[stream] = { ...repo.coverage[stream], status: "complete", fetchedAt: collected };
	await save("factory", snapshot);
	await raw
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'R1',?)")
		.bind(account, collected)
		.run();
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('R1',?,'R1','completed','{}',?,?,?)",
		)
		.bind(account, collected, collected, collected)
		.run();
	const stored = async () =>
		(await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).results;
	const read = async (query: Record<string, string> = {}) => {
		const profile = profileDb(raw);
		const data = await readSources(createDb(profile.raw), account, query);
		expect(profile.queries).toHaveLength(7);
		expect(profile.trips).toHaveLength(1);
		return { data, profile };
	};
	return { raw, save, snapshot, repo, stored, read };
}

it("R9 CI source versions match /ci when publication provenance is present without hashing injected fields", async () => {
	const s = await fixture();
	const before = await s.stored();
	const network = vi.spyOn(globalThis, "fetch");
	try {
		const { data } = await s.read();
		const ci = await readObservation(createDb(s.raw), account, "ci", "all");
		expect(data.sources.find((source) => source.resource === "account:ci")).toMatchObject({
			version: ci.sourceVersion,
			contentVersion: ci.contentVersion,
			runId: "R1",
			fetchedAt: published,
			observedAt: collected,
		});
		expect(await s.stored()).toEqual(before);
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
	}
});

it("R9 since between collection and publication includes every newly visible source at all filter stages", async () => {
	const s = await fixture();
	const full = await s.read();
	const before = await s.stored();
	const incremental = await s.read({ since: between });
	expect(full.data.sources).toHaveLength(17);
	expect(incremental.data).toEqual(full.data);
	for (const source of incremental.data.sources)
		expect(source).toMatchObject({ runId: "R1", fetchedAt: published, observedAt: collected });
	for (const since of [published, "2026-10-22T13:00:00+08:00"])
		expect((await s.read({ since })).data.sources).toEqual([]);
	for (const read of [full, incremental])
		expect(read.profile.queries.reduce((bytes, row) => bytes + row.payloadBytes, 0)).toBe(
			full.profile.queries.reduce((bytes, row) => bytes + row.payloadBytes, 0),
		);
	expect(await s.stored()).toEqual(before);
});

it("R9 account CI provenance uses every catalog input independently of repository and since filters", async () => {
	const s = await fixture();
	const newer = "owner/newer";
	await s.save("repos", {
		repos: [repository, newer].map((name) => ({ name_with_owner: name })),
		publication,
	});
	for (const [suffix, fields] of [
		["actions", { runs: [] }],
		["releases", { releases: [] }],
		["details", { default_branch: "main" }],
	] as const)
		await s.save(`repo:${newer}:${suffix}`, {
			...fields,
			publication: { runId: "R2", publishedAt: later },
		});
	const full = (await s.read()).data.sources.find((source) => source.resource === "account:ci");
	expect(full).toMatchObject({ runId: "R2", fetchedAt: later, observedAt: collected });
	const { data } = await s.read({ repository, since: "2026-10-22T05:30:00.000Z" });
	expect(data.sources.find((source) => source.resource === "account:ci")).toEqual(full);
	expect(data.sources.some((source) => source.resource.startsWith("repo:"))).toBe(false);
});

it("R9 retained R1 streams keep their persisted publication time under a newer partial R2 head and after run retention", async () => {
	const s = await fixture();
	s.snapshot.runId = "R2";
	s.snapshot.publication = { runId: "R2", publishedAt: later, mixed: true };
	for (const stream of FACTORY_STREAMS)
		s.repo.coverage[stream] = { ...s.repo.coverage[stream], retained: true };
	await s.save("factory", s.snapshot);
	await s.raw
		.prepare("UPDATE factory_state SET published_id='R2' WHERE account_id=?")
		.bind(account)
		.run();
	for (const retained of [true, false]) {
		if (!retained) await s.raw.prepare("DELETE FROM factory_runs WHERE id='R1'").run();
		const { data } = await s.read({ since: between });
		for (const stream of FACTORY_STREAMS)
			expect(
				data.sources.find((source) => source.resource === `factory:${repository}:${stream}`),
			).toMatchObject({
				version: "R1",
				runId: "R1",
				fetchedAt: published,
				observedAt: collected,
			});
		expect(data.sources.find((source) => source.resource === "account:factory")).toMatchObject({
			runId: "R2",
			fetchedAt: later,
		});
		const afterR1 = await s.read({ since: "2026-10-22T05:30:00.000Z" });
		expect(afterR1.data.sources.some((source) => source.resource.startsWith("factory:"))).toBe(
			false,
		);
		expect(
			afterR1.data.sources.find((source) => source.resource === "account:factory"),
		).toBeDefined();
	}
});

it("R9 legacy observations without publication provenance keep their original observed time", async () => {
	const s = await fixture();
	delete s.repo.observation?.publishedAt;
	await s.save("factory", s.snapshot);
	const { data } = await s.read();
	for (const stream of FACTORY_STREAMS)
		expect(
			data.sources.find((source) => source.resource === `factory:${repository}:${stream}`),
		).toMatchObject({
			runId: "R1",
			fetchedAt: collected,
			observedAt: collected,
		});
	expect(
		(await s.read({ since: between })).data.sources.some((source) =>
			source.resource.startsWith("factory:"),
		),
	).toBe(false);
});
