import { expect, it, vi } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import {
	beginCatalog,
	catalogCreationTimes,
	catalogIdentity,
	catalogPlanWrites,
	catalogRetentionWrites,
	planCatalog,
} from "./catalog-history";
import { catalogRowIdentity, identifyCatalogRow } from "./catalog-identity";
import { collectRepos } from "./collect";
import { createDb } from "./db/d1";
import { enrichRepoAgentStates, writeRepoAgentState } from "./repo-agent-state";
import { enrichRepoMeta, readRepoMeta, writeRepoMeta } from "./repo-meta";

const at = "2026-10-22T00:00:00.000Z";
const created = "2020-01-01T00:00:00Z";
async function fixture() {
	const raw = sqliteFixture();
	for (const account of ["a", "b"])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,'fake','fake',?,?)",
			)
			.bind(account, account === "a" ? "owner" : "other", at, at)
			.run();
	const repo = async (
		identity = "R_app",
		name = "owner/app",
		account = "a",
		removed: string | null = null,
	) => {
		await raw
			.prepare(
				"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,removed_at,is_archived,visibility,is_fork,first_seen_source) VALUES(?,?,?,?,?,?,?, ?,0,'PUBLIC',0,'github_catalog')",
			)
			.bind(
				account,
				identity,
				identity,
				name,
				JSON.stringify({ name_with_owner: name }),
				at,
				at,
				removed,
			)
			.run();
	};
	await repo();
	const db = createDb(raw);
	const read = (name = "owner/app", account = "a") => readRepoMeta(db, account, name);
	const write = (patch: unknown, name = "owner/app", account = "a") =>
		writeRepoMeta(db, account, name, patch);
	const stored = async () =>
		(await raw.prepare("SELECT * FROM repo_meta ORDER BY account_id,identity_key").all()).results;
	return { raw, db, repo, read, write, stored };
}

it("R6 reads catalog timestamps and empty metadata without writes or upstream access", async () => {
	const s = await fixture();
	const network = vi.spyOn(globalThis, "fetch");
	try {
		expect(await s.read("OWNER/APP")).toEqual({
			account_id: "a",
			repo: "owner/app",
			repo_removed: false,
			created_at: null,
			first_seen_at: at,
			archived_at: null,
			deleted_at: null,
			category: null,
			exclusion_reason: null,
			updated_at: null,
			field_sources: {},
		});
		await expect(s.read("owner/missing")).rejects.toMatchObject({ status: 404 });
		expect(await s.stored()).toEqual([]);
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
	}
});

it("R6 atomically patches only specified fields and sources, including concurrent disjoint writes", async () => {
	const s = await fixture();
	await s.write({ created_at: created, exclusion_reason: "retained", category: "app" });
	await Promise.all([s.write({ archived_at: at }), s.write({ category: "docs-vault" })]);
	expect(await s.read()).toMatchObject({
		created_at: created,
		archived_at: at,
		category: "docs-vault",
		exclusion_reason: "retained",
		updated_at: expect.any(String),
		field_sources: {
			created_at: "agent",
			archived_at: "agent",
			category: "agent",
			exclusion_reason: "agent",
		},
	});
	const before = await s.stored();
	for (const patch of [
		{},
		{ unknown: true },
		{ created_at: null },
		{ category: "invalid" },
		{ first_seen_at: at },
	])
		await expect(s.write(patch)).rejects.toMatchObject({ status: 400, code: "invalid_payload" });
	expect(await s.stored()).toEqual(before);
});

it("R6 metadata follows identity through rename/removal, pins retention and isolates accounts/name replacements", async () => {
	const s = await fixture();
	await s.write({ category: "profile" });
	await s.raw
		.prepare(
			"UPDATE catalog_repositories SET repo='owner/renamed',removed_at=? WHERE account_id='a' AND identity_key='R_app'",
		)
		.bind(at)
		.run();
	await s.db.batch(catalogRetentionWrites(s.db, "a", "2027-10-22T00:00:00Z"));
	expect(await s.read("owner/renamed")).toMatchObject({
		repo_removed: true,
		deleted_at: at,
		first_seen_at: at,
		category: "profile",
	});
	expect(await s.write({ category: "repro" }, "owner/renamed")).toMatchObject({
		repo_removed: true,
		category: "repro",
	});
	await s.repo("R_new", "owner/renamed");
	expect(await s.read("owner/renamed")).toMatchObject({
		repo_removed: false,
		category: null,
		field_sources: {},
	});
	await s.repo("R_app", "owner/renamed", "b");
	expect(await s.read("owner/renamed", "b")).toMatchObject({ account_id: "b", category: null });
	await s.write({ category: "derivative" }, "owner/renamed", "b");
	expect(await s.read("owner/renamed")).toMatchObject({ category: null });
	await s.repo("R_removed", "owner/removed", "a", at);
	expect(await s.write({ category: "derivative" }, "owner/removed")).toMatchObject({
		repo_removed: true,
		category: "derivative",
	});
	await expect(s.write({ category: "app" }, "owner/unknown")).rejects.toMatchObject({
		status: 404,
	});
});

it("R6 both enrichment orders preserve private identity and distinct same-name removed metadata", async () => {
	const s = await fixture();
	await s.write({ category: "app" });
	await writeRepoAgentState(s.db, "a", "owner/app", { payload: { summary: "first" } }, "fixture");
	await s.raw
		.prepare("UPDATE catalog_repositories SET removed_at=? WHERE identity_key='R_app'")
		.bind(at)
		.run();
	await s.repo("R_new");
	await s.write({ category: "docs-vault" });
	await s.raw
		.prepare("UPDATE catalog_repositories SET removed_at=? WHERE identity_key='R_new'")
		.bind(at)
		.run();
	for (const reverse of [false, true]) {
		let data: Record<string, unknown> = {
			repos: [
				identifyCatalogRow({ name_with_owner: "owner/app" }, "R_app"),
				identifyCatalogRow({ name_with_owner: "owner/app" }, "R_new"),
				{ name_with_owner: "owner/legacy" },
			],
		};
		data = reverse
			? await enrichRepoMeta(s.db, "a", data)
			: await enrichRepoAgentStates(s.db, "a", data);
		const first = (data.repos as object[])[0];
		expect(first && catalogRowIdentity(first)).toBe("R_app");
		data = reverse
			? await enrichRepoAgentStates(s.db, "a", data)
			: await enrichRepoMeta(s.db, "a", data);
		expect(data.repos).toEqual([
			expect.objectContaining({
				meta: expect.objectContaining({ category: "app", deleted_at: at }),
				agent_state: expect.objectContaining({ summary: "first" }),
			}),
			expect.objectContaining({
				meta: expect.objectContaining({ category: "docs-vault" }),
				agent_state: null,
			}),
			expect.objectContaining({ meta: null, agent_state: null }),
		]);
	}
	expect(await enrichRepoMeta(s.db, "a", {})).toEqual({ repos: [] });
});

it("R6 the existing catalog request collects createdAt without wire changes and publication never replaces agent values", async () => {
	const s = await fixture();
	const queries: { query: string; variables: Record<string, unknown> }[] = [];
	let name = "owner/app";
	let collectedAt = created;
	const gh = github((_url, init) => {
		const body = JSON.parse(String(init?.body)) as {
			query: string;
			variables: Record<string, unknown>;
		};
		queries.push(body);
		return Response.json({
			data: {
				viewer: {
					repositories: {
						nodes: [{ id: "R_app", nameWithOwner: name, createdAt: collectedAt }],
						pageInfo: { hasNextPage: false },
					},
				},
			},
		});
	});
	for (const [index, time] of [at, "2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z"].entries()) {
		const baseline = await beginCatalog(s.db, "a");
		const payload = await collectRepos(gh, "fixture");
		expect(JSON.stringify(payload)).not.toContain("createdAt");
		expect(JSON.stringify(payload)).not.toContain("created_at");
		const plan = await planCatalog(
			baseline,
			payload,
			catalogIdentity(payload),
			"owner",
			gh,
			"fixture",
			time,
			{ kind: "legacy", runId: null },
		);
		await s.db.batch(catalogPlanWrites(s.db, "a", plan));
		if (index === 0) {
			expect(await s.read()).toMatchObject({
				created_at: created,
				field_sources: { created_at: "catalog" },
			});
			await s.write({ created_at: "2019-01-01T00:00:00Z", category: "app" });
			name = "owner/renamed";
			collectedAt = "2021-01-01T00:00:00Z";
		} else
			expect(await s.read(name)).toMatchObject({
				created_at: "2019-01-01T00:00:00Z",
				category: "app",
				field_sources: { created_at: "agent", category: "agent" },
			});
	}
	expect(queries).toHaveLength(3);
	expect(
		queries.every(
			(query) =>
				query.query.includes("viewer") &&
				query.query.includes("createdAt") &&
				!query.query.includes("nodes(ids:"),
		),
	).toBe(true);
});

it("R6 staged catalog fills only empty fields and atomically preserves a later agent patch", async () => {
	const s = await fixture();
	const gh = github(() => {
		throw new Error("No upstream required");
	});
	const payload = { truncated: false, repos: [{ name_with_owner: "owner/app" }] };
	catalogCreationTimes(payload, { R_app: created });
	const plan = await planCatalog(
		await beginCatalog(s.db, "a"),
		payload,
		{ "owner/app": "R_app" },
		"owner",
		gh,
		"fixture",
		at,
		{ kind: "factory", runId: "staged" },
	);
	await s.write({ category: "app" });
	const staged = JSON.parse(JSON.stringify(plan)) as typeof plan;
	await s.db.batch(catalogPlanWrites(s.db, "a", staged));
	expect(await s.read()).toMatchObject({
		created_at: created,
		category: "app",
		field_sources: { created_at: "catalog", category: "agent" },
	});
	const next = await planCatalog(
		await beginCatalog(s.db, "a"),
		payload,
		{ "owner/app": "R_app" },
		"owner",
		gh,
		"fixture",
		"2026-10-23T00:00:00Z",
		{ kind: "factory", runId: "next" },
	);
	await s.write({ created_at: "2018-01-01T00:00:00Z" });
	const before = await s.stored();
	await s.db.batch(catalogPlanWrites(s.db, "a", next));
	expect(await s.stored()).toEqual(before);
});

it("R6 delayed catalog publication never regresses a later metadata update time", async () => {
	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date(at));
		const setup = await fixture();
		const payload = { truncated: false, repos: [{ name_with_owner: "owner/app" }] };
		catalogCreationTimes(payload, { R_app: created });
		const plan = await planCatalog(
			await beginCatalog(setup.db, "a"),
			payload,
			{ "owner/app": "R_app" },
			"owner",
			github(() => {
				throw new Error("No upstream required");
			}),
			"fixture",
			at,
			{ kind: "factory", runId: "delayed" },
		);
		vi.setSystemTime(new Date("2026-10-22T02:00:00.000Z"));
		await setup.write({ category: "docs-vault" });
		vi.setSystemTime(new Date("2026-10-22T03:00:00.000Z"));
		await setup.db.batch(catalogPlanWrites(setup.db, "a", plan));
		expect(await setup.read()).toMatchObject({
			created_at: created,
			category: "docs-vault",
			updated_at: "2026-10-22T03:00:00.000Z",
			field_sources: { created_at: "catalog", category: "agent" },
		});
		const published = await setup.stored();
		vi.setSystemTime(new Date("2026-10-22T04:00:00.000Z"));
		const next = await planCatalog(
			await beginCatalog(setup.db, "a"),
			payload,
			{ "owner/app": "R_app" },
			"owner",
			github(() => {
				throw new Error("No upstream required");
			}),
			"fixture",
			new Date().toISOString(),
			{ kind: "factory", runId: "subsequent" },
		);
		await setup.db.batch(catalogPlanWrites(setup.db, "a", next));
		expect(await setup.stored()).toEqual(published);
	} finally {
		vi.useRealTimers();
	}
});

it("R6 missing or invalid optional creation timestamps never become catalog metadata", async () => {
	const gh = github(() =>
		Response.json({
			data: {
				viewer: {
					repositories: {
						nodes: [
							{ id: "R_valid", nameWithOwner: "owner/valid", createdAt: created },
							{ id: "R_invalid", nameWithOwner: "owner/invalid", createdAt: "invalid" },
							{ id: "R_missing", nameWithOwner: "owner/missing" },
						],
						pageInfo: { hasNextPage: false },
					},
				},
			},
		}),
	);
	const payload = await collectRepos(gh, "fixture");
	expect(payload.truncated).toBe(false);
	expect(catalogCreationTimes(payload)).toEqual({ R_valid: created });
	expect(gh.count).toBe(1);
});

it("R6 confirmed catalog removal preserves agent fields and uses catalog deletion time without copying it", async () => {
	const s = await fixture();
	await s.repo("R_proof", "owner/proof");
	await s.raw
		.prepare(
			"UPDATE catalog_repositories SET visibility='PRIVATE',row_payload=? WHERE identity_key='R_proof'",
		)
		.bind(JSON.stringify({ name_with_owner: "owner/proof", is_private: true }))
		.run();
	await s.write({ created_at: created, category: "app", exclusion_reason: "preserved" });
	const before = await s.stored();
	const gh = github(() =>
		Response.json({
			data: { node: null },
			errors: [{ type: "NOT_FOUND", message: "Not Found", path: ["node"] }],
		}),
	);
	const removed = "2026-10-23T00:00:00.000Z";
	const plan = await planCatalog(
		await beginCatalog(s.db, "a"),
		{ truncated: false, repos: [{ name_with_owner: "owner/proof", is_private: true }] },
		{ "owner/proof": "R_proof" },
		"owner",
		gh,
		"fixture",
		removed,
		{ kind: "legacy", runId: null },
	);
	await s.db.batch(catalogPlanWrites(s.db, "a", plan));
	expect(await s.read()).toMatchObject({
		repo_removed: true,
		deleted_at: removed,
		created_at: created,
		category: "app",
		exclusion_reason: "preserved",
		field_sources: { created_at: "agent", category: "agent", exclusion_reason: "agent" },
	});
	expect(await s.stored()).toEqual(before);
});
