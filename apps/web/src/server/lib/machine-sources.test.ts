import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import {
	savedObservationStmts as replaceSnapshotStmts,
	syncSavedObservation,
} from "../../../../../tests/fixtures/refresh";
import { refreshActivityFixture } from "../../../../../tests/fixtures/refresh-activity";
import { populateSourceStreams, sourcesFixture } from "../../../../../tests/fixtures/sources";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import * as ci from "../../lib/ci-health";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { readActivity } from "./activity-store";
import { savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import { readSnapshot } from "./db/snapshots";
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
	snap.repos.push({ ...first, id: "R_REMOVED", name: "nocoo/removed" });
	snap.inventory.excluded.push({ name: "nocoo/removed", reason: "fork" });
	await save("factory", snap);
	const before = await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all();
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
		expect(await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).toEqual(
			before,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	} finally {
		fetchSpy.mockRestore();
	}
});

it("reads 126 repositories within seven queries and bounds empty-since hashing", async () => {
	const { raw, account, names } = await sourcesFixture();
	const before = (await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).results;
	const fullDb = createDb(raw);
	const fullDigest = vi.spyOn(crypto.subtle, "digest");
	const full = await readSources(fullDb, account, {});
	const fullDigests = fullDigest.mock.calls.length;
	fullDigest.mockRestore();
	expect(fullDigests).toBeLessThan(12);
	expect(fullDb.statements).toBeLessThanOrEqual(7);
	expect(full.repositories).toEqual(names);
	expect(full.sources).toHaveLength(1518);
	for (const query of [
		{ repository: "FIXTURE/PROJECT-001" },
		{ since: "2026-10-19T00:00:00.000Z" },
		{ since: "2026-10-21T00:00:00.000Z" },
	]) {
		const db = createDb(raw);
		const result = await readSources(db, account, query);
		expect(db.statements).toBeLessThanOrEqual(7);
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
	expect(
		(await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).results,
	).toEqual(before);
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
				"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at) VALUES(?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(account, kind, JSON.stringify({ ...data, fetched_at: at }), at)
			.run();
		if (persist) {
			const logical = kind.replace(/#2$/, "");
			const data = await readSnapshot(createDb(raw), account, logical);
			if (data)
				await raw
					.prepare(
						"UPDATE refresh_snapshots SET content_meta=? WHERE account_id=? AND kind IN (?,?)",
					)
					.bind(await savedContentMeta(logical, data), account, logical, `${logical}#2`)
					.run();
		}
		await syncSavedObservation(createDb(raw), account, kind, at);
		if (!persist)
			await raw
				.prepare("UPDATE refresh_resources SET content_meta=NULL WHERE account_id=?")
				.bind(account)
				.run();
	};
	return { raw, account, save };
}

it("indexes the canonical activity publication as account:activity", async () => {
	const { raw, now } = await refreshActivityFixture();
	const network = vi.spyOn(globalThis, "fetch");
	const saved = async () =>
		(await raw.prepare("SELECT kind,payload FROM refresh_snapshots ORDER BY kind").all()).results;
	const before = await saved();
	try {
		const activity = await readActivity(createDb(raw), "a", {});
		expect(activity).toMatchObject({
			runId: "current-refresh",
			membership: ["owner/app"],
			repos: [{ issues: { opened: [{ id: "I_1" }] } }],
		});
		const result = await readSources(createDb(raw), "a", {});
		expect(result.sources.find((source) => source.resource === "account:activity")).toEqual({
			resource: "account:activity",
			version: "current-refresh",
			contentVersion: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			runId: "current-refresh",
			observedAt: now,
			fetchedAt: now,
			freshness: { oldestAt: now, latestAt: now, total: 1, missing: 0 },
			coverage: {
				repos: { status: "complete", truncated: false, reason: null },
				run: {
					status: "partial",
					truncated: false,
					reason: "owner_commit_attribution_unavailable",
				},
				contributions: {
					status: "unavailable",
					truncated: false,
					reason: "native_calendar_has_no_activity_attribution",
				},
			},
			truncated: false,
			unavailable: false,
		});
		const original = (await readSources(createDb(raw), "a", {})).sources.find(
			(source) => source.resource === "account:activity",
		);
		for (const query of [{ repository: "OWNER/APP" }, { since: "2026-10-29T03:59:59.999Z" }])
			expect(
				(await readSources(createDb(raw), "a", query)).sources.find(
					(source) => source.resource === "account:activity",
				),
			).toEqual(original);
		expect(
			(await readSources(createDb(raw), "a", { since: now })).sources.some(
				(source) => source.resource === "account:activity",
			),
		).toBe(false);
		await raw
			.prepare(
				"UPDATE refresh_resources SET content_meta=json_set(content_meta,'$.hash','sha256:changed') WHERE stream='issues'",
			)
			.run();
		const changed = (await readSources(createDb(raw), "a", {})).sources.find(
			(source) => source.resource === "account:activity",
		);
		expect(changed?.version).toBe(original?.version);
		expect(changed?.fetchedAt).toBe(original?.fetchedAt);
		expect(changed?.contentVersion).not.toBe(original?.contentVersion);
		expect(await saved()).toEqual(before);
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
	}
});

it("matches /activity evidence for next, pagination reasons, missing resources and version mismatch", async () => {
	const { raw } = await refreshActivityFixture();
	const patch = async (stream: string, change: (data: Record<string, unknown>) => void) => {
		const row = await raw
			.prepare("SELECT payload FROM refresh_resources WHERE stream=?")
			.bind(stream)
			.first<{ payload: string }>();
		if (!row) throw new Error("missing stream fixture");
		const data = JSON.parse(row.payload) as Record<string, unknown>;
		change(data);
		await raw
			.prepare("UPDATE refresh_resources SET payload=? WHERE stream=?")
			.bind(JSON.stringify(data), stream)
			.run();
	};
	const read = async () => {
		const activity = await readActivity(createDb(raw), "a", {});
		const source = (await readSources(createDb(raw), "a", {})).sources.find(
			(row) => row.resource === "account:activity",
		);
		expect(source?.version).toBe(activity.runId);
		expect(source?.coverage).toEqual(activity.coverage);
		expect(source?.truncated).toBe(activity.truncated);
		return { activity, source };
	};
	expect((await read()).source).toMatchObject({ truncated: false, freshness: { missing: 0 } });
	await patch("issues", (data) => {
		data.next = "cursor-2";
	});
	expect((await read()).activity.truncated).toBe(true);
	await patch("issues", (data) => {
		delete data.next;
	});
	expect((await read()).activity.truncated).toBe(true);
	await patch("issues", (data) => {
		data.next = null;
	});
	expect((await read()).activity.truncated).toBe(false);
	await patch("actions", (data) => {
		data.coverage = { ...(data.coverage as object), status: "partial", reason: "latest_page_only" };
	});
	expect((await read()).activity.truncated).toBe(true);
	await patch("prs", (data) => {
		data.coverage = {
			...(data.coverage as object),
			status: "partial",
			reason: "incomplete_pagination",
		};
	});
	expect((await read()).activity.truncated).toBe(true);
	await raw.prepare("DELETE FROM refresh_resources WHERE stream='releases'").run();
	const missing = await read();
	expect(missing.activity.repos[0]?.coverage.releases).toMatchObject({
		status: "unavailable",
		reason: "source_missing",
	});
	expect(missing.source?.freshness).toMatchObject({ total: 1, missing: 1 });
	await patch("issues", (data) => {
		data.runId = "other-run";
	});
	const mismatch = await read();
	expect(mismatch.activity.repos[0]?.coverage.issues).toMatchObject({
		status: "unavailable",
		reason: "source_version_mismatch",
	});
});

it("keeps account activity on current owned catalog members regardless of repository filter", async () => {
	const { raw, now } = await refreshActivityFixture();
	const baseline = (await readSources(createDb(raw), "a", {})).sources.find(
		(source) => source.resource === "account:activity",
	);
	for (const [id, repo, active] of [
		["R_NEW", "owner/second", 1],
		["R_FOREIGN", "someone/else", 1],
		["R_GONE", "owner/gone", 0],
	] as const)
		await raw
			.prepare(
				"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES('a',?,?,'2026-10-29','Asia/Shanghai','{}',?,?)",
			)
			.bind(id, repo, now, active)
			.run();
	const activity = await readActivity(createDb(raw), "a", {});
	expect(activity.membership).toEqual(["owner/app", "owner/second"]);
	const unfiltered = await readSources(createDb(raw), "a", {});
	const source = unfiltered.sources.find((row) => row.resource === "account:activity");
	expect(source).toMatchObject({
		version: "current-refresh",
		runId: "current-refresh",
		freshness: { total: 2, missing: 1, oldestAt: now, latestAt: now },
	});
	expect(source?.contentVersion).not.toBe(baseline?.contentVersion);
	const filtered = await readSources(createDb(raw), "a", { repository: "OWNER/APP" });
	expect(filtered.sources.filter((row) => row.resource.startsWith("account:"))).toEqual(
		unfiltered.sources.filter((row) => row.resource.startsWith("account:")),
	);
	expect(filtered.sources.some((row) => row.resource === "account:activity")).toBe(true);
	expect(
		(await readSources(createDb(raw), "a", { since: now })).sources.some(
			(row) => row.resource === "account:activity",
		),
	).toBe(false);
	expect(
		(await readSources(createDb(raw), "a", { since: "2026-10-29T03:59:59.999Z" })).sources.find(
			(row) => row.resource === "account:activity",
		),
	).toEqual(source);
});

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
		[{}, 0, 1518],
		[{ since: "2026-10-21T00:00:00Z" }, 0, 0],
		[{ repository: repository.toUpperCase() }, 0, 18],
		[{ repository, since: fixture.latest }, 0, 0],
	] as const) {
		const profile = profileDb(fixture.raw);
		const result = await readSources(createDb(profile.raw), fixture.account, query);
		expect(result.sources).toHaveLength(count);
		expect(profile.queries).toHaveLength(7);
		expect(profile.queries.reduce((sum, row) => sum + row.payloadBytes, 0)).toBe(
			baseBytes + Number(expectedBytes),
		);
		if (count === 18)
			expect(
				result.sources.find((source) => source.resource === `factory:${repository}:commits`)
					?.contentVersion,
			).toMatch(/^sha256:[0-9a-f]{64}$/);
	}
	expect(payloads.size).toBe(126);
	const profile = profileDb(fixture.raw);
	const before = await readSources(createDb(profile.raw), fixture.account, {});
	const query = profile.queries.find((query) => query.sql.includes("FROM refresh_resources"));
	if (!query) throw new Error("missing metadata query");
	expect(query.sql).toContain("json_extract(r.payload,'$.coverage')");
	expect(query.sql).not.toMatch(/json_extract\(r\.payload,'\$\.(items|manifests)/);
	await fixture.raw.prepare("UPDATE refresh_resources SET payload='not-json'").run();
	const after = await readSources(createDb(fixture.raw), fixture.account, {});
	expect(after.sources).toEqual(before.sources);
	expect(after.sources.find((source) => source.resource === "account:activity")).toMatchObject({
		version: "publication-local-bench",
		fetchedAt: fixture.latest,
		observedAt: null,
		freshness: {
			oldestAt: null,
			latestAt: null,
			total: fixture.names.length,
			missing: fixture.names.length,
		},
		truncated: false,
		unavailable: false,
	});
});

it("keeps raw legacy hashes null while versioning account list and CI projections", async () => {
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
	for (const source of result.sources) {
		if (["account:repos", "account:issues", "account:ci"].includes(source.resource))
			expect(source.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
		else expect(source.contentVersion).toBeNull();
	}
	for (const resource of ["repo:owner/app:issues", "factory"])
		expect(
			(await readObservation(createDb(raw), account, resource, "all")).contentVersion,
		).toBeNull();
	expect(
		(await readFactoryResource(createDb(raw), account, "owner/app", "commits")).contentVersion,
	).toBeNull();
});

it.each([
	["issues", "issues"],
	["prs", "prs"],
	["actions", "ci"],
	["releases", "ci"],
	["details", "ci"],
] as const)(
	"versions a legacy %s input for account:%s without writes",
	async (suffix, resource) => {
		const { raw, account, save } = await savedFixture();
		await save("repos", {
			repos: [{ name_with_owner: "owner/old", is_archived: true, is_fork: true }],
		});
		await save("issues", { issues: [] });
		await save("prs", { pull_requests: [] });
		for (const tab of ["issues", "prs", "actions", "releases", "details"])
			await save(
				`repo:owner/old:${tab}`,
				{ issues: [], pull_requests: [], runs: [], releases: [], default_branch: "main" },
				"2026-10-21T00:00:00Z",
			);
		const legacy = `repo:owner/old:${suffix}`;
		await raw
			.prepare("UPDATE refresh_snapshots SET content_meta=NULL WHERE kind=?")
			.bind(legacy)
			.run();
		expect(
			(await raw.prepare("SELECT kind FROM refresh_snapshots WHERE content_meta IS NULL").all())
				.results,
		).toEqual([{ kind: legacy }]);
		const before = await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all();
		const read = async () =>
			(await readSources(createDb(raw), account, {})).sources.find(
				(source) => source.resource === `account:${resource}`,
			);
		const original = await read();
		expect(original?.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(await read()).toEqual(original);
		expect((await readObservation(createDb(raw), account, resource, "all")).contentVersion).toBe(
			original?.contentVersion,
		);
		expect(await raw.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).toEqual(
			before,
		);
		await raw
			.prepare(
				"UPDATE refresh_snapshots SET payload=json_set(payload,'$.legacy_evidence',1) WHERE kind=?",
			)
			.bind(legacy)
			.run();
		expect((await read())?.contentVersion).not.toBe(original?.contentVersion);
	},
);

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
		kept.id = "R_KEPT";
		const other = { ...kept, id: "R_OTHER", name: "owner/other" };
		await save("repos", {
			repos: [kept, other].map((repo) => ({ id: repo.id, name_with_owner: repo.name })),
		});
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
			await raw
				.prepare(
					"INSERT INTO refresh_resources(account_id,repo_id,stream,payload,content_meta) VALUES(?,?,?,?,?)",
				)
				.bind(account, name === kept.name ? kept.id : other.id, stream, payload, meta)
				.run();
		}
		const profile = profileDb(raw);
		const result = await readSources(createDb(profile.raw), account, query);
		expect(profile.queries).toHaveLength(7);
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
	const { raw, account, names, latest, old } = await sourcesFixture();
	const result = await readSources(createDb(raw), account, {});
	expect(result.repositories).toEqual(names);
	expect(result.sources.map((source) => source.resource).sort()).toEqual(
		[
			...names.flatMap((name) =>
				["details", "issues", "prs", "actions", "releases"].map(
					(suffix) => `repo:${name}:${suffix}`,
				),
			),
			...["issues", "prs", "ci", "factory", "repos", "activity"].map((kind) => `account:${kind}`),
			...names.flatMap((name) => FACTORY_STREAMS.map((stream) => `factory:${name}:${stream}`)),
		].sort(),
	);
	expect(result.sources.find((source) => source.resource === "account:activity")).toMatchObject({
		version: "publication-local-bench",
		runId: "publication-local-bench",
		fetchedAt: latest,
		observedAt: null,
		freshness: { oldestAt: null, latestAt: null, total: names.length, missing: names.length },
		truncated: false,
		unavailable: false,
	});
	for (const source of result.sources.filter(
		(source) => source.resource.startsWith("account:") && source.resource !== "account:activity",
	))
		expect(source.freshness).toEqual({
			oldestAt: old,
			latestAt: source.resource === "account:repos" ? old : latest,
			total: names.length,
			missing: 0,
		});
	expect(result.sources.find((source) => source.resource === "account:factory")).toMatchObject({
		freshness: { total: 126, missing: 0 },
		version: "publication-local-bench",
	});
	expect(await readSources(createDb(raw), account, {})).toEqual(result);
	for (const source of result.sources.filter(
		(row) => !row.resource.startsWith("factory:") && row.resource !== "account:activity",
	)) {
		const resource = source.resource.replace(/^account:/, "");
		const envelope = await readObservation(createDb(raw), account, resource, "all");
		expect(source).toEqual({
			resource: source.resource,
			runId: source.resource === "account:factory" ? source.version : null,
			observedAt: envelope.fetchedAt,
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
			"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at) VALUES(?,'repo:owner/orphan:issues#2','invalid-json','bad')",
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

it("omits absent sources and ignores retired immutable heads", async () => {
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
	).toBe(true);
});

it("indexes immutable IDs, excludes foreign accounts and rejects mismatched stream versions", async () => {
	const { raw, account, save } = await savedFixture();
	const publication = factoryFixture();
	const template = publication.repos[0];
	if (!template) throw new Error("missing fixture repository");
	const names = ["owner/renamed", "owner/second", "owner/foreign"];
	publication.repos = names.map((name, index) => ({
		...structuredClone(template),
		id: `R_${index}`,
		name,
		observation: {
			repo: index === 0 ? "OWNER/ORIGINAL" : name,
			version: "original",
			source: "run",
			window: publication.window,
			refreshedAt: publication.fetched_at,
		},
	}));
	await save("repos", {
		repos: publication.repos.map((repo) => ({ id: repo.id, name_with_owner: repo.name })),
	});
	await save("factory", publication);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('foreign','foreign','fake','fake','t','t')",
		)
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
	for (const [index, repo] of publication.repos.entries())
		await raw
			.prepare(
				"INSERT INTO refresh_resources(account_id,repo_id,stream,payload,content_meta) VALUES(?,?,'commits',?,?)",
			)
			.bind(
				index === 2 ? "foreign" : account,
				repo.id,
				JSON.stringify(stream),
				await savedContentMeta(`factory:${repo.name}:commits`, stream),
			)
			.run();
	const profile = profileDb(raw);
	const index = await readSources(createDb(profile.raw), account, {});
	expect(profile.queries).toHaveLength(7);
	for (const name of names.slice(0, 2)) {
		const envelope = await readFactoryResource(createDb(raw), account, name, "commits");
		expect(
			index.sources.find((source) => source.resource === `factory:${name}:commits`)?.contentVersion,
		).toBe(envelope.contentVersion);
	}
	expect(
		index.sources.find((source) => source.resource === "factory:owner/foreign:commits")
			?.contentVersion,
	).toBeNull();
	await expect(
		readFactoryResource(createDb(raw), account, "owner/foreign", "commits"),
	).rejects.toMatchObject({ status: 409 });
	const updated = { ...stream, items: [{ ...stream.items[0], title: "changed" }] };
	await raw
		.prepare("UPDATE refresh_resources SET payload=?,content_meta=? WHERE account_id=?")
		.bind(JSON.stringify(updated), await savedContentMeta("factory:repo:commits", updated), account)
		.run();
	const changed = await readSources(createDb(raw), account, {});
	for (const name of names.slice(0, 2)) {
		const previous = index.sources.find((source) => source.resource === `factory:${name}:commits`);
		const current = changed.sources.find((source) => source.resource === `factory:${name}:commits`);
		expect(current?.version).toBe(previous?.version);
		expect(current?.contentVersion).not.toBe(previous?.contentVersion);
	}
	await raw
		.prepare("UPDATE refresh_resources SET payload=?,content_meta=? WHERE account_id=?")
		.bind(
			JSON.stringify({ ...stream, runId: "newer" }),
			await savedContentMeta("factory:repo:commits", { ...stream, runId: "newer" }),
			account,
		)
		.run();
	expect(
		(await readSources(createDb(raw), account, {})).sources.find(
			(source) => source.resource === "factory:owner/renamed:commits",
		)?.contentVersion,
	).toBeNull();
	await expect(
		readFactoryResource(createDb(raw), account, "owner/renamed", "commits"),
	).rejects.toMatchObject({
		status: 409,
		message: "immutable source version mismatch; refresh this repository",
	});
});
