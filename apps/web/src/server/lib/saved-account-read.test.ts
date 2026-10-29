import { afterEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { savedObservationStmts as replaceSnapshotStmts } from "../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "./db/d1";
import { publishedFactory } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { readFactoryRate } from "./factory-rate";
import {
	readCiObservation,
	readMachineAccountObservation,
	readObservation,
} from "./machine-observations";
import { enrichRepoAgentStates } from "./repo-agent-state";
import { enrichRepoMeta } from "./repo-meta";
import {
	accountReadPlan,
	decodePublication,
	type PublicationPage,
	savedAccountPolicy,
} from "./saved-observation-read";
import { publicationSnapshotStatement } from "./saved-observation-statements";
import {
	factoryFreshness,
	projectFactory,
	repoPolicy,
	scopedSnapshot,
} from "./snapshot-projection";
import type { SnapshotScope } from "./snapshot-scope";

const account = "a".repeat(21);
const at = "2026-10-20T12:00:00.000Z";
const resources = ["repos", "issues", "prs", "ci", "factory"] as const;
async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'nocoo','fake','fake',1,?,?)",
		)
		.bind(account, at, at)
		.run();
	const save = async (kind: string, data: Record<string, unknown>) => {
		const db = createDb(raw);
		await db.batch(await replaceSnapshotStmts(db, account, kind, data, at));
	};
	await save("repos", {
		repos: [
			{ name_with_owner: "nocoo/app", is_fork: true, is_archived: true },
			{ name_with_owner: "nocoo/other" },
			{ name_with_owner: "outside/app" },
		],
	});
	for (const name of ["NOCOO/APP", "outside/app"])
		await raw
			.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,?)")
			.bind(account, name)
			.run();
	for (const [kind, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
	] as const) {
		await save(kind, { [key]: [{ name_with_owner: "nocoo/app", number: 1, state: "OPEN" }] });
		await save(`repo:NOCOO/APP:${kind}`, { [key]: [{ number: 2, state: "OPEN" }] });
	}
	await save("repo:NOCOO/APP:actions", { runs: [] });
	await save("repo:NOCOO/APP:details", { default_branch: "main" });
	await save("repo:NOCOO/APP:releases", { releases: [] });
	const snapshot = factoryFixture();
	snapshot.publication = { runId: snapshot.runId, mixed: true, publishedAt: at };
	await save(`factory`, snapshot);
	await raw
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,?,'t')")
		.bind(account, snapshot.runId)
		.run();
	await raw
		.prepare(
			"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at) VALUES(?,'repo:nocoo/orphan:actions#2','invalid-json',?)",
		)
		.bind(account, at)
		.run();
	return { raw, save };
}

async function browserReference(raw: D1Database, kind: string, scope: SnapshotScope) {
	const db = createDb(raw);
	if (kind === "ci")
		return {
			...(await readCiObservation(db, account, await repoPolicy(db, account, undefined, scope))),
			account_id: account,
		};
	if (kind === "factory") {
		const policy = await repoPolicy(db, account, undefined, scope);
		const snap = await publishedFactory(db, account);
		if (!snap) throw new Error("fixture publication missing");
		const projected = projectFactory(snap, policy);
		const freshness = factoryFreshness(projected, policy);
		return {
			...projected,
			rate: await readFactoryRate(db, account, snap.rate),
			fetched_at: freshness.latestAt ?? "",
			freshness,
			truncated:
				projected.truncated === true ||
				projected.inventory.complete !== true ||
				freshness.missing > 0,
			account_id: account,
		};
	}
	const snap = await readSnapshot(db, account, kind);
	if (!snap) throw new Error("fixture source missing");
	const projected = await scopedSnapshot(db, account, kind, snap, scope);
	const enriched =
		kind === "repos"
			? await enrichRepoMeta(db, account, await enrichRepoAgentStates(db, account, projected))
			: projected;
	return { ...enriched, account_id: account };
}

afterEach(() => vi.unstubAllGlobals());

it.each(resources)(
	"batches browser %s observations with bounded contextual metadata",
	async (kind) => {
		const s = await fixture();
		for (const metadata of ["stored", "mismatched", "legacy"]) {
			if (metadata === "mismatched") {
				const row = await s.raw
					.prepare("SELECT payload FROM refresh_snapshots WHERE account_id=? AND kind='repos'")
					.bind(account)
					.first<{ payload: string }>();
				if (!row) throw new Error("fixture catalog");
				const data = JSON.parse(row.payload);
				await s.raw
					.prepare("UPDATE refresh_snapshots SET payload=? WHERE account_id=? AND kind='repos'")
					.bind(JSON.stringify({ ...data, repos: data.repos.slice(0, 1) }), account)
					.run();
				await s.raw
					.prepare(
						"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,'repos#2',?,?,?)",
					)
					.bind(
						account,
						JSON.stringify({ ...data, repos: data.repos.slice(1) }),
						at,
						'{"hash":"different"}',
					)
					.run();
			}
			if (metadata === "legacy")
				await s.raw.prepare("UPDATE refresh_snapshots SET content_meta=NULL").run();
			for (const scope of ["all", "starred"] as const) {
				const expected = JSON.stringify(await browserReference(s.raw, kind, scope));
				const profile = profileDb(s.raw);
				const network = vi.fn(() => {
					throw new Error("saved reads cannot use network");
				});
				vi.stubGlobal("fetch", network);
				const response = await createApp().request(
					`http://localhost/api/${kind}?scope=${scope}`,
					{},
					{
						DB: profile.raw,
						ENVIRONMENT: "development",
						GITHUB_API_BASE: "http://fixture",
					} as Env,
				);
				expect(response.status).toBe(200);
				expect(await response.text()).toBe(expected);
				expect(response.headers.get("cache-control")).toBe("private, no-store");
				expect(network).not.toHaveBeenCalled();
				expect(profile.trips).toHaveLength(kind === "repos" ? 3 : 1);
				expect(profile.trips[0]?.statements).toBeGreaterThan(1);
				if (kind === "repos") {
					expect(profile.trips[1]?.statements).toBe(1);
					expect(profile.trips[2]?.statements).toBe(1);
					expect(profile.queries.at(-2)?.sql).toContain("FROM repo_agent_state");
					expect(profile.queries.at(-1)?.sql).toContain("LEFT JOIN repo_meta");
				}
			}
		}
	},
);

it.each(resources)(
	"batches saved machine %s inputs without hidden projection queries",
	async (kind) => {
		const s = await fixture();
		const expected = JSON.stringify(await readObservation(createDb(s.raw), account, kind, "all"));
		const profile = profileDb(s.raw);
		expect(JSON.stringify(await readObservation(createDb(profile.raw), account, kind, "all"))).toBe(
			expected,
		);
		expect(profile.trips).toHaveLength(1);
		expect(profile.trips[0]?.statements).toBeGreaterThan(1);
	},
);

it("keeps browser missing-source errors before malformed catalog decoding", async () => {
	const s = await fixture();
	await s.raw.prepare("DELETE FROM refresh_snapshots WHERE kind='issues'").run();
	await s.raw
		.prepare("UPDATE refresh_snapshots SET payload='invalid-json' WHERE kind='repos'")
		.run();
	const response = await createApp().request("http://localhost/api/issues", {}, {
		DB: s.raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({
		error: { code: "snapshot_missing", message: "no snapshot for issues" },
	});
});

it("composes account inputs with caller-owned statements in one batch", async () => {
	const s = await fixture();
	const profile = profileDb(s.raw);
	const db = createDb(profile.raw);
	const plan = accountReadPlan(db, account, "repos", "starred");
	const results = await db.batch([...plan.statements, db.prepare("SELECT 42 AS answer")]);
	const saved = plan.decode(results);
	expect(saved.account).toEqual({ id: account, login: "nocoo" });
	expect(savedAccountPolicy(saved, "starred").repos).toMatchObject([
		{ name_with_owner: "nocoo/app" },
	]);
	expect(results[plan.statements.length]?.results).toEqual([{ answer: 42 }]);
	expect(profile.trips).toHaveLength(1);
	expect(() => plan.decode(results.slice(0, 1))).toThrow("incomplete observation batch");
});

it.each(["absent", "retired"])(
	"reads only canonical factory pages with a %s legacy head in one statement",
	async (head) => {
		const s = await fixture();
		if (head === "absent") {
			await s.raw.prepare("DELETE FROM factory_state").run();
		}
		await s.save("factory:v:unreferenced", { ignored: true });
		const expected = await publishedFactory(createDb(s.raw), account);
		const profile = profileDb(s.raw);
		const db = createDb(profile.raw);
		const rows = await db.batch<PublicationPage>([publicationSnapshotStatement(db, account)]);
		expect(decodePublication(rows[0]?.results ?? [])).toEqual(expected);
		expect(profile.trips).toHaveLength(1);
		expect(profile.queries).toHaveLength(1);
		expect(profile.queries[0]?.rows).toBe(1);
	},
);

it("does not decode unused corrupt repository pages for empty scopes or non-list payloads", async () => {
	const s = await fixture();
	await s.raw
		.prepare(
			"UPDATE refresh_snapshots SET payload='invalid-json' WHERE kind='repo:NOCOO/APP:issues'",
		)
		.run();
	await s.raw.prepare("DELETE FROM repo_stars").run();
	const request = (scope: string) =>
		createApp().request(`http://localhost/api/issues?scope=${scope}`, {}, {
			DB: s.raw,
			ENVIRONMENT: "development",
			GITHUB_API_BASE: "http://fixture",
		} as Env);
	expect((await request("starred")).status).toBe(200);
	expect(
		(await readObservation(createDb(s.raw), account, "issues", "starred")).data.issues,
	).toEqual([]);
	await s.save("issues", { issues: null });
	expect((await request("all")).status).toBe(200);
	expect((await readObservation(createDb(s.raw), account, "issues", "all")).data.issues).toBeNull();
});

it.each(resources)("serves complete machine %s with bounded saved-input reads", async (kind) => {
	const s = await fixture();
	const rate = {
		resource: "core",
		remaining: 3000,
		observedAt: at,
		resetAt: "2099-01-01T00:00:00.000Z",
	};
	await s.raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('rate',?,'rate','completed',?,'t','t','t')",
		)
		.bind(account, JSON.stringify({ checkpoint: { rate } }))
		.run();
	await s.raw
		.prepare(
			"UPDATE refresh_publications SET payload=json_set(payload,'$.rate',json(?)) WHERE account_id=?",
		)
		.bind(JSON.stringify(rate), account)
		.run();
	for (const scope of ["all", "starred"] as const) {
		const expected = await readObservation(createDb(s.raw), account, kind, scope);
		if (kind === "repos")
			expected.data.repos = (expected.data.repos as { name_with_owner: string }[]).map((repo) => ({
				...repo,
				retained: repo.name_with_owner === "nocoo/app" ? { any: false, streams: [] } : null,
			}));
		if (kind === "factory")
			expected.data.rate = await readFactoryRate(
				createDb(s.raw),
				account,
				expected.data.rate as null,
			);
		const profile = profileDb(s.raw);
		const actual = await readMachineAccountObservation(createDb(profile.raw), account, kind, scope);
		expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
		expect(actual.sourceVersion).toBe(expected.sourceVersion);
		if (kind === "factory") expect(actual.data.rate).toEqual(rate);
		expect(profile.trips).toHaveLength(kind === "repos" ? 2 : 1);
	}
});

it("defers speculative malformed-rate errors until the original rate overlay stage", async () => {
	const s = await fixture();
	await s.raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('bad-rate',?,'bad-rate','completed','invalid-json','t','t','t')",
		)
		.bind(account)
		.run();
	await s.raw.prepare("DELETE FROM refresh_snapshots WHERE kind IN ('factory','factory#2')").run();
	await s.raw.prepare("DELETE FROM refresh_publications").run();
	const request = () =>
		createApp().request("http://localhost/api/factory", {}, {
			DB: s.raw,
			ENVIRONMENT: "development",
			GITHUB_API_BASE: "http://fixture",
		} as Env);
	expect((await request()).status).toBe(409);
	await expect(
		readMachineAccountObservation(createDb(s.raw), account, "factory", "all"),
	).rejects.toMatchObject({ code: "snapshot_missing" });
	const snap = factoryFixture();
	await s.save(`factory`, snap);
	expect((await request()).status).toBe(200);
	await s.raw.prepare("UPDATE refresh_publications SET payload='invalid-json'").run();
	const response = await request();
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({ error: { code: "db_error", message: "d1 error" } });
	await expect(
		readMachineAccountObservation(createDb(s.raw), account, "factory", "all"),
	).rejects.toMatchObject({ code: "db_error" });
});
