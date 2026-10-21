import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { populateSourceStreams, sourcesFixture } from "../../../../../tests/fixtures/sources";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import * as ci from "../../lib/ci-health";
import { savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { readFactoryResource, readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";

it("filters every repository source and factory inventory against the current catalog without deleting history", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snap = factoryFixture();
	const account = snap.account_id;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(account)
		.run();
	const save = async (kind: string, value: Record<string, unknown>) =>
		db.batch(await replaceSnapshotStmts(db, account, kind, value, snap.fetched_at));
	await save("repos", { repos: [{ name_with_owner: "nocoo/app" }] });
	for (const name of ["NOCOO/APP", "nocoo/removed"])
		for (const suffix of ["details", "issues", "prs", "actions", "releases"])
			await save(`repo:${name}:${suffix}`, {
				runs: [],
				issues: [],
				pull_requests: [],
				releases: [],
			});
	const first = snap.repos[0];
	if (!first) throw new Error("fixture");
	snap.repos.push({ ...first, name: "nocoo/removed" });
	snap.inventory.excluded.push({ name: "nocoo/removed", reason: "fork" });
	await save("factory", snap);
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	const fetchSpy = vi.spyOn(globalThis, "fetch");
	try {
		const sources = await readSources(createDb(raw), account, {});
		expect(sources.sources.some((source) => source.resource.includes("removed"))).toBe(false);
		expect(sources.sources.filter((source) => source.resource.startsWith("repo:"))).toHaveLength(5);
		expect(
			(await readSources(createDb(raw), account, { repository: "NOCOO/APP" })).sources.filter(
				(source) => source.resource.startsWith("repo:"),
			),
		).toHaveLength(5);
		const factory = await readObservation(db, account, "factory", "all");
		expect(factory.data.repos).toHaveLength(1);
		expect(factory.data.inventory).toMatchObject({ excluded: [] });
		expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
		expect(fetchSpy).not.toHaveBeenCalled();
	} finally {
		fetchSpy.mockRestore();
	}
});

it("reads 126 repositories within five queries and bounds empty-since hashing", async () => {
	const { raw, account, names } = await sourcesFixture();
	const before = (await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results;
	const fullDb = createDb(raw);
	const fullDigest = vi.spyOn(crypto.subtle, "digest");
	const full = await readSources(fullDb, account, {});
	const fullDigests = fullDigest.mock.calls.length;
	fullDigest.mockRestore();
	expect(fullDigests).toBeLessThan(10);
	expect(fullDb.statements).toBeLessThanOrEqual(5);
	expect(full.repositories).toEqual(names);
	expect(full.sources).toHaveLength(1517);
	for (const query of [
		{ repository: "FIXTURE/PROJECT-001" },
		{ since: "2026-10-19T00:00:00.000Z" },
		{ since: "2026-10-21T00:00:00.000Z" },
	]) {
		const db = createDb(raw);
		const result = await readSources(db, account, query);
		expect(db.statements).toBeLessThanOrEqual(5);
		expect(result.repositories).toEqual(names);
	}
	const digest = vi.spyOn(crypto.subtle, "digest");
	try {
		expect(
			(await readSources(createDb(raw), account, { since: "2099-01-01T00:00:00Z" })).sources,
		).toEqual([]);
		expect(digest.mock.calls.reduce((bytes, call) => bytes + call[1].byteLength, 0)).toBeLessThan(
			100_000,
		);
	} finally {
		digest.mockRestore();
	}
	expect((await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results).toEqual(
		before,
	);
});

async function savedFixture(persist = true) {
	const raw = sqliteFixture();
	const account = "source-edge";
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'owner','fake','fake','t','t')",
		)
		.bind(account)
		.run();
	const save = async (kind: string, data: Record<string, unknown>, at = "2026-10-20T00:00:00Z") => {
		await raw
			.prepare(
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(account, kind, JSON.stringify({ ...data, fetched_at: at }), at)
			.run();
		if (persist) {
			const logical = kind.replace(/#2$/, "");
			const data = await readSnapshot(createDb(raw), account, logical);
			if (data)
				await raw
					.prepare("UPDATE snapshots SET content_meta=? WHERE account_id=? AND kind IN (?,?)")
					.bind(await savedContentMeta(logical, data), account, logical, `${logical}#2`)
					.run();
		}
	};
	return { raw, account, save };
}

it("does not build a CI report excluded by since", async () => {
	const fixture = await sourcesFixture();
	const report = vi.spyOn(ci, "ciReport");
	try {
		expect(
			(await readSources(createDb(fixture.raw), fixture.account, { since: fixture.latest }))
				.sources,
		).toEqual([]);
		expect(report).not.toHaveBeenCalled();
	} finally {
		report.mockRestore();
	}
});

it.each(["ci", "factory"])(
	"hashes derived %s evidence quality, not observation times",
	async (resource) => {
		const { raw, account, save } = await savedFixture();
		await save("repos", { repos: [{ name_with_owner: "owner/app" }] });
		const publication = factoryFixture();
		const template = publication.repos[0];
		if (!template) throw new Error("missing fixture");
		const seed = async (at: string | null) => {
			await save("factory", {
				...publication,
				repos: [
					{
						...template,
						name: "owner/app",
						observation: {
							version: "original",
							source: "legacy",
							window: publication.window,
							refreshedAt: at,
						},
					},
				],
			});
			await save("repo:owner/app:actions", { runs: [] });
			await save("repo:owner/app:releases", { releases: [] });
			await save("repo:owner/app:details", { default_branch: "main" }, at ?? "");
			const result = await readSources(createDb(raw), account, {});
			const source = result.sources.find((row) => row.resource === `account:${resource}`);
			expect(source?.contentVersion).toBe(
				(await readObservation(createDb(raw), account, resource, "all")).contentVersion,
			);
			return source;
		};
		const original = await seed("2026-10-20T00:00:00Z");
		expect(original?.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(original?.freshness).toMatchObject({ missing: 0 });
		for (const at of [null, "bad-date"]) {
			const missing = await seed(at);
			expect(missing?.freshness).toMatchObject({ missing: 1 });
			expect(missing?.contentVersion).not.toBe(original?.contentVersion);
		}
		expect((await seed("2026-10-21T00:00:00Z"))?.contentVersion).toBe(original?.contentVersion);
	},
);

it("never reads immutable payloads for full or filtered source indexes", async () => {
	const fixture = await sourcesFixture();
	const baseline = profileDb(fixture.raw);
	await readSources(createDb(baseline.raw), fixture.account, {});
	const baseBytes = baseline.queries.reduce((sum, query) => sum + query.payloadBytes, 0);
	const payloads = await populateSourceStreams(fixture);
	const repository = "fixture/project-001";
	for (const [query, expectedBytes, count] of [
		[{}, 0, 1517],
		[{ since: "2026-10-21T00:00:00Z" }, 0, 0],
		[{ repository: repository.toUpperCase() }, 0, 17],
		[{ repository, since: fixture.latest }, 0, 0],
	] as const) {
		const profile = profileDb(fixture.raw);
		const result = await readSources(createDb(profile.raw), fixture.account, query);
		expect(result.sources).toHaveLength(count);
		expect(profile.queries).toHaveLength(5);
		expect(profile.queries.reduce((sum, row) => sum + row.payloadBytes, 0)).toBe(
			baseBytes + Number(expectedBytes),
		);
		if (count === 17)
			expect(
				result.sources.find((source) => source.resource === `factory:${repository}:commits`)
					?.contentVersion,
			).toMatch(/^sha256:[0-9a-f]{64}$/);
	}
	expect(payloads.size).toBe(126);
	const profile = profileDb(fixture.raw);
	const before = await readSources(createDb(profile.raw), fixture.account, {});
	const query = profile.queries.at(-1);
	if (!query) throw new Error("missing metadata query");
	const plan = await fixture.raw
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.bind(...query.bindings)
		.all<{ detail: string }>();
	expect(
		plan.results.some((row) => row.detail.includes("COVERING INDEX factory_resources_content")),
	).toBe(true);
	expect(plan.results.some((row) => row.detail.includes("COVERING INDEX snapshots_content"))).toBe(
		true,
	);
	await fixture.raw.prepare("UPDATE factory_resources SET payload='not-json'").run();
	expect(await readSources(createDb(fixture.raw), fixture.account, {})).toEqual(before);
});

it("does not invent content hashes for legacy saved sources", async () => {
	const { raw, account, save } = await savedFixture(false);
	await save("repos", { repos: [{ name_with_owner: "owner/app" }] });
	await save("issues", { issues: [] });
	await save("repo:owner/app:issues", { issues: [] });
	const publication = factoryFixture();
	const repo = publication.repos[0];
	if (!repo) throw new Error("missing fixture");
	repo.name = "owner/app";
	await save("factory", publication);
	await save("factory:owner/app:commits", {
		runId: publication.runId,
		items: [],
		ranges: [],
		next: null,
		coverage: repo.coverage.commits,
	});
	const result = await readSources(createDb(raw), account, {});
	for (const source of result.sources) expect(source.contentVersion).toBeNull();
	for (const resource of ["repos", "issues", "repo:owner/app:issues", "ci", "factory"])
		expect(
			(await readObservation(createDb(raw), account, resource, "all")).contentVersion,
		).toBeNull();
	expect(
		(await readFactoryResource(createDb(raw), account, "owner/app", "commits")).contentVersion,
	).toBeNull();
});

it.each(["run", "legacy"] as const)(
	"filters %s streams individually using both publication pages",
	async (source) => {
		const { raw, account, save } = await savedFixture();
		const snap = factoryFixture();
		const template = snap.repos[0];
		if (!template) throw new Error("missing fixture");
		const kept = structuredClone(template);
		kept.name = "owner/kept";
		kept.observation = {
			source,
			version: "original",
			window: snap.window,
			refreshedAt: snap.fetched_at,
		};
		kept.coverage.commits.fetchedAt = "2026-10-20T01:00:00+01:00";
		kept.coverage.issues.fetchedAt = "2026-10-20T00:00:00.001Z";
		const other = { ...kept, name: "owner/other" };
		await save("repos", { repos: [kept, other].map((repo) => ({ name_with_owner: repo.name })) });
		await save("factory", { ...snap, repos: [other] });
		await save("factory#2", { ...snap, repos: [kept] });
		const query = { repository: "OWNER/KEPT", since: "2026-10-20T00:00:00Z" };
		const baseline = profileDb(raw);
		await readSources(createDb(baseline.raw), account, query);
		const baselineBytes = baseline.queries.reduce((sum, row) => sum + row.payloadBytes, 0);
		await raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('original',?,'original','completed','{}','t','t','t')",
			)
			.bind(account)
			.run();
		for (const [name, stream] of [
			[kept.name, "issues"],
			[kept.name, "commits"],
			[other.name, "issues"],
		] as const) {
			const selected = name === kept.name && stream === "issues";
			const payload = JSON.stringify({
				runId: "original",
				items: [{ id: "1", title: selected ? "selected" : "x".repeat(900_000) }],
				next: null,
				ranges: [],
				coverage: kept.coverage[stream],
				fetched_at: snap.fetched_at,
			});
			const meta = await savedContentMeta(`factory:${name}:${stream}`, JSON.parse(payload));
			if (source === "run")
				await raw
					.prepare(
						"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES('original',?,?,?,?)",
					)
					.bind(name, stream, payload, meta)
					.run();
			else
				await raw
					.prepare(
						"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?)",
					)
					.bind(account, `factory:${name}:${stream}`, payload, snap.fetched_at, meta)
					.run();
		}
		const profile = profileDb(raw);
		const result = await readSources(createDb(profile.raw), account, query);
		expect(profile.queries).toHaveLength(5);
		expect(profile.queries.reduce((sum, row) => sum + row.payloadBytes, 0)).toBe(baselineBytes);
		expect(result.sources.some((row) => row.resource === "factory:owner/kept:commits")).toBe(false);
		expect(result.sources.some((row) => row.resource.startsWith("factory:owner/other:"))).toBe(
			false,
		);
		expect(
			result.sources.find((row) => row.resource === "factory:owner/kept:issues")?.contentVersion,
		).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(result.sources.find((row) => row.resource === "factory:owner/kept:prs")).toMatchObject({
			fetchedAt: null,
			contentVersion: null,
		});
	},
);

it("preserves exact realistic response content and all advertised snapshot versions", async () => {
	const { raw, account } = await sourcesFixture();
	const result = await readSources(createDb(raw), account, {});
	const legacy = {
		...result,
		sources: result.sources.map(({ contentVersion: _contentVersion, ...source }) => source),
	};
	expect(result.sources.find((source) => source.resource === "account:factory")).toMatchObject({
		freshness: { total: 103, missing: 0 },
		version: "publication-local-bench",
	});
	expect(createHash("sha256").update(JSON.stringify(legacy)).digest("hex")).toBe(
		"2ebafc5288489326287eda2e7897cb111286ae3824fb3f66c17a7da404a4fe07",
	);
	for (const source of result.sources.filter((row) => !row.resource.startsWith("factory:"))) {
		const resource = source.resource.replace(/^account:/, "");
		const envelope = await readObservation(createDb(raw), account, resource, "all");
		expect(source).toEqual({
			resource: source.resource,
			version: envelope.sourceVersion,
			contentVersion: envelope.contentVersion,
			fetchedAt: envelope.fetchedAt,
			freshness: envelope.freshness,
			coverage: envelope.coverage,
			truncated: envelope.truncated,
			unavailable: envelope.unavailable,
		});
	}
});

it("keeps content versions across identical refreshes, including time-derived CI", async () => {
	const { raw, account, save } = await savedFixture();
	const seed = async (at: string, title = "same") => {
		await save("repos", { repos: [{ name_with_owner: "owner/app" }] }, at);
		await save("issues", { issues: [{ name_with_owner: "owner/app", title }] }, at);
		await save("prs", { pull_requests: [] }, at);
		await save("repo:owner/app:details", { default_branch: "main" }, at);
		await save("repo:owner/app:actions", { runs: [] }, at);
		await save("repo:owner/app:releases", { releases: [] }, at);
	};
	await seed("2026-10-01T00:00:00Z");
	const before = await readSources(createDb(raw), account, {});
	await seed("2026-10-20T00:00:00Z");
	const refreshed = await readSources(createDb(raw), account, {});
	for (const source of refreshed.sources) {
		const previous = before.sources.find((row) => row.resource === source.resource);
		expect(source.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(source.contentVersion).toBe(previous?.contentVersion);
		expect(source.version).not.toBe(previous?.version);
		const envelope = await readObservation(
			createDb(raw),
			account,
			source.resource.replace(/^account:/, ""),
			"all",
		);
		expect(source.contentVersion).toBe(envelope.contentVersion);
	}
	await seed("2026-10-20T00:00:00Z", "changed");
	const changed = await readSources(createDb(raw), account, {});
	expect(changed.sources.find((s) => s.resource === "account:issues")?.contentVersion).not.toBe(
		refreshed.sources.find((s) => s.resource === "account:issues")?.contentVersion,
	);
});

it("shares decoded alias pages without replacing latest-complete inbox evidence with latest-any", async () => {
	const { raw, account, save } = await savedFixture();
	await save(
		"repos",
		{ repos: [{ name_with_owner: "owner/app" }, { name_with_owner: "owner/orphan" }] },
		"2026-10-15T00:00:00Z",
	);
	await save("issues", { issues: [] }, "2026-10-15T00:00:00Z");
	await save("repo:OWNER/APP:issues", { issues: [{ number: 1 }] }, "2026-10-18T00:00:00Z");
	await save("repo:OWNER/APP:issues#2", { issues: [{ number: 2 }] }, "2026-10-18T00:00:00Z");
	await save("repo:owner/app:issues", { issues: [{ number: 3 }], truncated: true });
	await raw
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,'repo:owner/orphan:issues#2','invalid-json','bad')",
		)
		.bind(account)
		.run();
	let result = await readSources(createDb(raw), account, {});
	const page = await readObservation(createDb(raw), account, "repo:owner/app:issues", "all");
	let inbox = await readObservation(createDb(raw), account, "issues", "all");
	expect(page.data.issues).toEqual([{ number: 3 }]);
	expect(inbox.data.issues).toEqual([
		{ number: 1, name_with_owner: "owner/app" },
		{ number: 2, name_with_owner: "owner/app" },
	]);
	expect(result.sources.find((row) => row.resource === "repo:owner/app:issues")?.version).toBe(
		page.sourceVersion,
	);
	expect(result.sources.find((row) => row.resource === "account:issues")?.version).toBe(
		inbox.sourceVersion,
	);
	expect(result.sources.some((row) => row.resource.includes("orphan:issues"))).toBe(false);
	await save("repo:owner/app:issues", { issues: [{ number: 4 }], unavailable: true });
	result = await readSources(createDb(raw), account, {});
	inbox = await readObservation(createDb(raw), account, "issues", "all");
	expect(result.sources.find((row) => row.resource === "repo:owner/app:issues")).toMatchObject({
		unavailable: true,
	});
	expect(result.sources.find((row) => row.resource === "account:issues")?.version).toBe(
		inbox.sourceVersion,
	);
});

it("preserves since max-time, strict equality and conservative missing or malformed times", async () => {
	const { raw, account, save } = await savedFixture();
	await save("repos", { repos: [{ name_with_owner: "owner/app" }] });
	await save(
		"repo:owner/app:details",
		{ freshness: { latestAt: "2026-10-21T01:00:00+01:00" } },
		"2026-10-18T00:00:00Z",
	);
	await save("repo:owner/app:issues", { issues: [], freshness: "unknown" }, "invalid");
	await save("repo:owner/app:prs", { pull_requests: [] }, "invalid");
	await save("repo:OWNER/APP:prs", { pull_requests: [{ number: 1 }] }, "invalid");
	await save("repo:owner/app:releases", { releases: [] }, "2026-10-21T00:00:00Z");
	await save("repo:owner/app:actions", { runs: [], freshness: { latestAt: "invalid" } }, "invalid");
	const query = { since: "2026-10-21T00:00:00.000Z" };
	const result = await readSources(createDb(raw), account, query);
	expect(
		result.sources.filter((row) => row.resource.startsWith("repo:")).map((row) => row.resource),
	).toEqual(["repo:OWNER/APP:prs", "repo:owner/app:actions", "repo:owner/app:issues"]);
	const earlier = await readSources(createDb(raw), account, { since: "2026-10-20T23:59:59Z" });
	expect(earlier.sources.some((row) => row.resource === "repo:owner/app:details")).toBe(true);
	await expect(
		readSources(createDb(raw), account, { repository: "owner/missing" }),
	).rejects.toMatchObject({ status: 404 });
	await expect(readSources(createDb(raw), account, { since: "bad" })).rejects.toMatchObject({
		status: 400,
	});
});

it("omits absent sources and never substitutes a legacy publication for a missing immutable head", async () => {
	const { raw, account, save } = await savedFixture();
	expect(await readSources(createDb(raw), account, {})).toEqual({
		account_id: account,
		repositories: [],
		sources: [],
	});
	await save("repos", { repos: [{ name_with_owner: "nocoo/app" }] });
	await save("factory", factoryFixture());
	expect(
		(await readSources(createDb(raw), account, {})).sources.some(
			(row) => row.resource === "account:factory",
		),
	).toBe(true);
	await raw
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'missing','t')")
		.bind(account)
		.run();
	expect(
		(await readSources(createDb(raw), account, {})).sources.some((row) =>
			row.resource.includes("factory"),
		),
	).toBe(false);
});

it("projects stored immutable hashes, including second pages, not newer or foreign runs", async () => {
	const { raw, account, save } = await savedFixture();
	const publication = factoryFixture();
	const template = publication.repos[0];
	if (!template) throw new Error("missing repository fixture");
	const names = ["owner/renamed", "owner/legacy", "owner/foreign"];
	await save("repos", { repos: names.map((name) => ({ name_with_owner: name })) });
	publication.repos = names.map((name, i) => ({
		...structuredClone(template),
		name,
		observation: {
			repo: i === 0 ? "OWNER/ORIGINAL" : name,
			version: i === 2 ? "foreign" : "original",
			source: i === 1 ? "legacy" : "run",
			refreshedAt: publication.fetched_at,
			window: publication.window,
		},
	}));
	await save("factory", publication);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('foreign','foreign','fake','fake','t','t')",
		)
		.run();
	for (const [id, owner] of [
		["original", account],
		["newer", account],
		["foreign", "foreign"],
	])
		await raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'completed','{}','t','t','t')",
			)
			.bind(id, owner, id)
			.run();
	const stream = {
		runId: "original",
		items: [{ id: "1", title: "original", at: "2026-10-01T00:00:00Z" }],
		next: null,
		ranges: [publication.window],
		coverage: {
			...template.coverage.commits,
			status: "complete",
			fetchedAt: publication.fetched_at,
		},
	};
	for (const [version, repo] of [
		["original", "OWNER/ORIGINAL"],
		["newer", "owner/renamed"],
		["foreign", "owner/foreign"],
	])
		await raw
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES(?,?,'commits',?,?)",
			)
			.bind(
				version,
				repo,
				JSON.stringify({ ...stream, runId: version }),
				await savedContentMeta(`factory:${repo}:commits`, { ...stream, runId: version }),
			)
			.run();
	await save("factory:owner/legacy:commits", stream);
	await save("factory:owner/legacy:commits#2", {
		...stream,
		items: [{ id: "2", title: "second page" }],
	});
	const before = await raw
		.prepare("SELECT * FROM factory_resources ORDER BY run_id,repo,stream")
		.all();
	const db = createDb(raw);
	const index = await readSources(db, account, {});
	expect(db.statements).toBeLessThanOrEqual(5);
	for (const name of names.slice(0, 2)) {
		const envelope = await readFactoryResource(createDb(raw), account, name, "commits");
		expect(
			index.sources.find((s) => s.resource === `factory:${name}:commits`)?.contentVersion,
		).toBe(envelope.contentVersion);
	}
	expect(
		index.sources.find((s) => s.resource === "factory:owner/foreign:commits")?.contentVersion,
	).toBeNull();
	expect(
		await raw.prepare("SELECT * FROM factory_resources ORDER BY run_id,repo,stream").all(),
	).toEqual(before);
	await raw
		.prepare("UPDATE factory_resources SET payload=?,content_meta=? WHERE run_id='original'")
		.bind(
			JSON.stringify({ ...stream, items: [{ ...stream.items[0], title: "changed" }] }),
			await savedContentMeta("factory:OWNER/ORIGINAL:commits", {
				...stream,
				items: [{ ...stream.items[0], title: "changed" }],
			}),
		)
		.run();
	await save("factory:owner/legacy:commits#2", {
		...stream,
		items: [{ id: "2", title: "changed second page" }],
	});
	const changed = await readSources(createDb(raw), account, {});
	for (const name of names.slice(0, 2)) {
		const previous = index.sources.find((s) => s.resource === `factory:${name}:commits`);
		const current = changed.sources.find((s) => s.resource === `factory:${name}:commits`);
		expect(current?.version).toBe(previous?.version);
		expect(current?.contentVersion).not.toBe(previous?.contentVersion);
	}
});
