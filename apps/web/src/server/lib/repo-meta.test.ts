import { expect, it, vi } from "vitest";

import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";

import { catalogRowIdentity, identifyCatalogRow } from "./catalog-identity";

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
			.prepare("UPDATE refresh_catalog SET active=0 WHERE account_id=? AND repo=? COLLATE NOCASE")
			.bind(account, name)
			.run();
		await raw
			.prepare(
				"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES(?,?,?,'2026-10-22','Asia/Shanghai',?,?,?)",
			)
			.bind(
				account,
				identity,
				name,
				JSON.stringify({ name_with_owner: name }),
				at,
				Number(removed === null),
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
			first_seen_at: null,
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

it("R6 metadata follows current identity through rename and isolates inactive identities, replacements and accounts", async () => {
	const s = await fixture();
	await s.write({ category: "profile" });
	await s.raw
		.prepare(
			"UPDATE refresh_catalog SET repo='owner/renamed' WHERE account_id='a' AND repo_id='R_app'",
		)
		.run();
	expect(await s.read("owner/renamed")).toMatchObject({
		repo_removed: false,
		deleted_at: null,
		first_seen_at: null,
		category: "profile",
	});
	expect(await s.write({ category: "repro" }, "owner/renamed")).toMatchObject({
		repo_removed: false,
		category: "repro",
	});
	await s.raw
		.prepare("UPDATE refresh_catalog SET active=0 WHERE account_id='a' AND repo_id='R_app'")
		.run();
	await expect(s.read("owner/renamed")).rejects.toMatchObject({ status: 404 });
	await expect(s.write({ category: "app" }, "owner/renamed")).rejects.toMatchObject({
		status: 404,
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
	await expect(s.write({ category: "derivative" }, "owner/removed")).rejects.toMatchObject({
		status: 404,
	});
	await expect(s.write({ category: "app" }, "owner/unknown")).rejects.toMatchObject({
		status: 404,
	});
});

it("R6 both enrichment orders preserve private identity without attaching inactive same-name metadata or state", async () => {
	const s = await fixture();
	await s.write({ category: "app" });
	await writeRepoAgentState(s.db, "a", "owner/app", { payload: { summary: "first" } }, "fixture");
	await s.raw.prepare("UPDATE refresh_catalog SET active=0 WHERE repo_id='R_app'").run();
	await s.repo("R_new");
	await s.write({ category: "docs-vault" });
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
				meta: null,
				agent_state: null,
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
