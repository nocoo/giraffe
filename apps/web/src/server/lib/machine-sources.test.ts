import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sourcesFixture } from "../../../../../tests/fixtures/sources";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { readObservation } from "./machine-observations";
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
	const save = (kind: string, value: Record<string, unknown>) =>
		db.batch(replaceSnapshotStmts(db, account, kind, value, snap.fetched_at));
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

it("reads 126 repositories within five queries and skips hashing sources excluded by since", async () => {
	const { raw, account, names } = await sourcesFixture();
	const before = (await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results;
	const fullDb = createDb(raw);
	const full = await readSources(fullDb, account, {});
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
		expect(digest).not.toHaveBeenCalled();
	} finally {
		digest.mockRestore();
	}
	expect((await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results).toEqual(
		before,
	);
});

async function savedFixture() {
	const raw = sqliteFixture();
	const account = "source-edge";
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'owner','fake','fake','t','t')",
		)
		.bind(account)
		.run();
	const save = (kind: string, data: Record<string, unknown>, at = "2026-10-20T00:00:00Z") =>
		raw
			.prepare(
				"INSERT INTO snapshots VALUES(?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(account, kind, JSON.stringify({ ...data, fetched_at: at }), at)
			.run();
	return { raw, account, save };
}

it("preserves exact realistic response content and all advertised snapshot versions", async () => {
	const { raw, account } = await sourcesFixture();
	const result = await readSources(createDb(raw), account, {});
	expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe(
		"36aaefea76bc2dde398677dde08a20af3c31dc305a276e582c17e8c0c186a393",
	);
	for (const source of result.sources.filter((row) => !row.resource.startsWith("factory:"))) {
		const resource = source.resource.replace(/^account:/, "");
		const envelope = await readObservation(createDb(raw), account, resource, "all");
		expect(source).toEqual({
			resource: source.resource,
			version: envelope.sourceVersion,
			fetchedAt: envelope.fetchedAt,
			freshness: envelope.freshness,
			coverage: envelope.coverage,
			truncated: envelope.truncated,
			unavailable: envelope.unavailable,
		});
	}
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
		.prepare("INSERT INTO snapshots VALUES(?,'repo:owner/orphan:issues#2','invalid-json','bad')")
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
