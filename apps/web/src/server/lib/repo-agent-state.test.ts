import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import {
	beginCatalog,
	catalogPlanWrites,
	catalogRetentionWrites,
	planCatalog,
} from "./catalog-history";
import { identifyCatalogRow } from "./catalog-identity";
import { createDb } from "./db/d1";
import { enrichRepoAgentStates, readRepoAgentState, writeRepoAgentState } from "./repo-agent-state";

const at = "2026-10-22T00:00:00.000Z";
async function fixture() {
	const raw = sqliteFixture();
	for (const account of ["a", "b"])
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,'encrypted','fake',?,?)",
			)
			.bind(account, account === "a" ? "owner" : "other", at, at)
			.run();
	async function repo(
		identity = "R_app",
		name = "owner/app",
		account = "a",
		removed: string | null = null,
	) {
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
	}
	await repo();
	const read = (name = "owner/app", account = "a") =>
		readRepoAgentState(createDb(raw), account, name);
	const write = (input: unknown, header?: string, name = "owner/app", account = "a") =>
		writeRepoAgentState(createDb(raw), account, name, input, "token-actor", header);
	const stored = async () =>
		(await raw.prepare("SELECT * FROM repo_agent_state ORDER BY account_id,identity_key").all())
			.results;
	return { raw, repo, read, write, stored };
}

it("R5 known repos without state return null fields while unknown repos return 404", async () => {
	const s = await fixture();
	expect(await s.read("OWNER/APP")).toEqual({
		account_id: "a",
		repo: "owner/app",
		repo_removed: false,
		payload: null,
		revision: null,
		updated_at: null,
		updated_by: null,
	});
	await expect(s.read("owner/unknown")).rejects.toMatchObject({ status: 404, code: "not_found" });
	expect(await s.stored()).toEqual([]);
});

it("R5 creates once and enforces missing/stale revisions without changing rejected writes", async () => {
	const s = await fixture();
	await expect(s.write({ revision: 1, payload: {} })).rejects.toMatchObject({
		status: 409,
		code: "revision_conflict",
	});
	const payload = {
		summary: "reviewed",
		status: "ok",
		memory: { anything: [1, null, true] },
		last_reviewed_at: { not_interpreted: true },
	};
	expect(await s.write({ payload })).toMatchObject({
		payload,
		revision: 1,
		updated_by: "token-actor",
		updated_at: expect.any(String),
	});
	const before = await s.stored();
	await expect(s.write({ payload: {} })).rejects.toMatchObject({
		status: 428,
		code: "precondition_required",
	});
	await expect(s.write({ revision: 2, payload: {} })).rejects.toMatchObject({
		status: 409,
		code: "revision_conflict",
	});
	expect(await s.stored()).toEqual(before);
	expect(await s.write({ revision: 1, payload: { next: true } })).toMatchObject({
		payload: { next: true },
		revision: 2,
	});
});

it("R5 If-Match takes precedence over a valid conflicting body revision", async () => {
	const s = await fixture();
	await s.write({ payload: {} });
	expect(await s.write({ revision: 99, payload: { header: true } }, '"1"')).toMatchObject({
		revision: 2,
	});
	await expect(s.write({ revision: 2, payload: {} }, '"1"')).rejects.toMatchObject({
		status: 409,
		code: "revision_conflict",
	});
});

it("accepts zero If-Match as create-only with one concurrent winner", async () => {
	const fixtureState = await fixture();
	const results = await Promise.allSettled([
		fixtureState.write({ revision: 99, payload: { first: true } }, '"0"'),
		fixtureState.write({ payload: { second: true } }, '"0"'),
	]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(results.find((result) => result.status === "rejected")).toMatchObject({
		reason: { status: 409, code: "revision_conflict" },
	});
	const before = await fixtureState.stored();
	await expect(fixtureState.write({ payload: {} }, '"0"')).rejects.toMatchObject({
		status: 409,
		code: "revision_conflict",
	});
	expect(await fixtureState.stored()).toEqual(before);
});

it.each(['W/"1"', "*", "1", '"00"', '"01"', '"-1"', '"1", "2"', '"9007199254740992"', ""])(
	"R5 rejects unsupported If-Match %j",
	async (header) => {
		const s = await fixture();
		await expect(s.write({ payload: {} }, header)).rejects.toMatchObject({
			status: 400,
			code: "invalid_payload",
		});
	},
);

it("R5 concurrent creates and revision updates have exactly one optimistic winner", async () => {
	const s = await fixture();
	for (const revision of [undefined, 1]) {
		const results = await Promise.allSettled(
			["first", "second"].map((winner) =>
				s.write({ ...(revision === undefined ? {} : { revision }), payload: { winner } }),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			reason: { status: 409, code: "revision_conflict" },
		});
	}
	expect((await s.read()).revision).toBe(2);
});

it("R5 payload cap counts serialized UTF-8 bytes and rejects 16385 without changing 16384", async () => {
	const s = await fixture();
	const payload = { x: `${"界".repeat(5458)}xx` };
	expect(new TextEncoder().encode(JSON.stringify(payload))).toHaveLength(16384);
	await s.write({ payload });
	const before = await s.stored();
	await expect(s.write({ revision: 1, payload: { x: `${payload.x}x` } })).rejects.toMatchObject({
		status: 400,
		code: "payload_too_large",
	});
	expect(await s.stored()).toEqual(before);
});

it.each([{}, { payload: null }, { payload: [] }, { payload: 1 }, { payload: {}, unknown: true }])(
	"R5 rejects invalid payload envelope %j",
	async (input) => {
		const s = await fixture();
		await expect(s.write(input)).rejects.toMatchObject({ status: 400, code: "invalid_payload" });
	},
);

it("R5 stable identity survives real catalog refresh, rename, removal and retention without modifying state", async () => {
	const s = await fixture();
	await s.repo("R_proof", "owner/proof");
	await s.raw
		.prepare(
			"UPDATE catalog_repositories SET visibility='PRIVATE',row_payload=? WHERE identity_key='R_proof'",
		)
		.bind(JSON.stringify({ name_with_owner: "owner/proof", is_private: true }))
		.run();
	await s.write({ payload: { summary: "preserved", arbitrary: { pointer: "memory" } } });
	const before = await s.stored();
	const gh = github(() =>
		Response.json({
			data: { node: null },
			errors: [{ type: "NOT_FOUND", message: "Not Found", path: ["node"] }],
		}),
	);
	for (const [time, name] of [
		["2026-10-23T00:00:00.000Z", "owner/app"],
		["2026-10-24T00:00:00.000Z", "owner/renamed"],
		["2026-10-25T00:00:00.000Z", null],
	] as const) {
		const db = createDb(s.raw);
		const repos = [
			{ name_with_owner: "owner/proof", is_private: true },
			...(name ? [{ name_with_owner: name }] : []),
		];
		const plan = await planCatalog(
			await beginCatalog(db, "a"),
			{ repos, truncated: false },
			{ "owner/proof": "R_proof", ...(name ? { [name]: "R_app" } : {}) },
			"owner",
			gh,
			"fixture",
			time,
			{ kind: "legacy", runId: null },
		);
		await db.batch(catalogPlanWrites(db, "a", plan));
		expect(await s.stored()).toEqual(before);
	}
	expect(await s.read("owner/renamed")).toMatchObject({
		repo_removed: true,
		revision: 1,
		payload: { summary: "preserved" },
	});
	await expect(s.read("owner/app")).rejects.toMatchObject({ status: 404 });
	await s.repo("R_unused", "owner/unused", "a", "2026-10-25T00:00:00.000Z");
	const db = createDb(s.raw);
	await db.batch(catalogRetentionWrites(db, "a", "2027-10-25T00:00:00.000Z"));
	expect(await s.read("owner/renamed")).toMatchObject({ repo_removed: true, revision: 1 });
	await expect(s.read("owner/unused")).rejects.toMatchObject({ status: 404 });
	expect(await s.stored()).toEqual(before);
	expect(
		await s.write({ revision: 1, payload: { removed_update: true } }, undefined, "owner/renamed"),
	).toMatchObject({ repo_removed: true, revision: 2 });
});

it("R5 removed repos need existing state and same-name replacement or other account never inherits it", async () => {
	const s = await fixture();
	await s.repo("R_removed", "owner/removed", "a", at);
	await expect(s.write({ payload: {} }, undefined, "owner/removed")).rejects.toMatchObject({
		status: 404,
	});
	await s.write({ payload: { private_state: true } });
	await s.raw
		.prepare(
			"UPDATE catalog_repositories SET removed_at=? WHERE account_id='a' AND identity_key='R_app'",
		)
		.bind(at)
		.run();
	await s.repo("R_replacement");
	expect(await s.read()).toMatchObject({ repo_removed: false, payload: null, revision: null });
	await s.repo("R_app", "owner/app", "b");
	expect(await s.read("owner/app", "b")).toMatchObject({ account_id: "b", payload: null });
	expect(await s.stored()).toHaveLength(1);
});

it("R5 /repos summaries are nullable and never attach removed identity state to a replacement", async () => {
	const s = await fixture();
	await s.write({ payload: { summary: "ready", status: "attention", arbitrary: "not projected" } });
	const enrich = (repos: Record<string, unknown>[]) =>
		enrichRepoAgentStates(createDb(s.raw), "a", { repos });
	expect(
		(
			await enrich([
				identifyCatalogRow({ name_with_owner: "owner/app" }, "R_app"),
				{ name_with_owner: "owner/unknown" },
			])
		).repos,
	).toEqual([
		{
			name_with_owner: "owner/app",
			agent_state: {
				revision: 1,
				updated_at: expect.any(String),
				summary: "ready",
				status: "attention",
			},
		},
		{ name_with_owner: "owner/unknown", agent_state: null },
	]);
	await s.write({ revision: 1, payload: { summary: "x".repeat(201), status: "custom" } });
	expect(
		(await enrich([identifyCatalogRow({ name_with_owner: "owner/app" }, "R_app")])).repos[0],
	).toMatchObject({
		agent_state: { summary: null, status: null },
	});
	await s.raw
		.prepare("UPDATE catalog_repositories SET removed_at=? WHERE identity_key='R_app'")
		.bind(at)
		.run();
	await s.repo("R_new");
	expect(
		(
			await enrich([
				identifyCatalogRow({ name_with_owner: "owner/app", removed_at: null }, "R_new"),
				identifyCatalogRow({ name_with_owner: "owner/app", removed_at: at }, "R_app"),
			])
		).repos,
	).toEqual([
		{ name_with_owner: "owner/app", removed_at: null, agent_state: null },
		{
			name_with_owner: "owner/app",
			removed_at: at,
			agent_state: { revision: 2, updated_at: expect.any(String), summary: null, status: null },
		},
	]);
});

it.each(["body", "If-Match"] as const)(
	"R5 old %s revision cannot overwrite a same-name replacement identity",
	async (precondition) => {
		const s = await fixture();
		const old = await s.write({ payload: { summary: "old identity" } });
		await s.raw
			.prepare(
				"UPDATE catalog_repositories SET removed_at=? WHERE account_id='a' AND identity_key='R_app'",
			)
			.bind(at)
			.run();
		await s.repo("R_new");
		const fresh = await s.write({ payload: { summary: "new identity" } });
		expect(fresh.revision).not.toBe(old.revision);
		const before = await s.stored();
		await expect(
			s.write(
				{
					...(precondition === "body" ? { revision: old.revision } : {}),
					payload: { summary: "stale overwrite" },
				},
				precondition === "If-Match" ? `"${old.revision}"` : undefined,
			),
		).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
		expect(await s.stored()).toEqual(before);
	},
);

it.each(["body", "If-Match"] as const)(
	"R5 old %s revision cannot cross repository identities after a name swap",
	async (precondition) => {
		const s = await fixture();
		await s.repo("R_second", "owner/second");
		const original = await s.write({ payload: { summary: "first" } });
		const second = await s.write({ payload: { summary: "second" } }, undefined, "owner/second");
		await s.raw
			.prepare("UPDATE catalog_repositories SET name_current=0 WHERE account_id='a'")
			.run();
		await s.raw
			.prepare(
				"UPDATE catalog_repositories SET repo=CASE identity_key WHEN 'R_app' THEN 'owner/second' ELSE 'owner/app' END,name_current=1 WHERE account_id='a'",
			)
			.run();
		const before = await s.stored();
		await expect(
			s.write(
				{
					...(precondition === "body" ? { revision: original.revision } : {}),
					payload: { wrong_identity: true },
				},
				precondition === "If-Match" ? `"${original.revision}"` : undefined,
			),
		).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
		expect((await s.read()).revision).toBe(second.revision);
		expect(await s.stored()).toEqual(before);
	},
);

it("R5 concurrent writes across identities allocate distinct account-monotonic revisions inside each write", async () => {
	const s = await fixture();
	const names = ["owner/app", "owner/second", "owner/third"];
	await s.repo("R_second", names[1]);
	await s.repo("R_third", names[2]);
	const created = await Promise.all(
		names.map((name) => s.write({ payload: { name } }, undefined, name)),
	);
	const revisions = created.map((state) => state.revision as number);
	expect(new Set(revisions).size).toBe(names.length);
	expect(Math.min(...revisions)).toBe(1);
	const updated = await Promise.all(
		created.map((state) =>
			s.write(
				{ revision: state.revision, payload: { updated: state.repo } },
				undefined,
				state.repo,
			),
		),
	);
	const next = updated.map((state) => state.revision as number);
	expect(new Set(next).size).toBe(names.length);
	expect(Math.min(...next)).toBeGreaterThan(Math.max(...revisions));
	await s.repo("R_other", "other/app", "b");
	expect((await s.write({ payload: {} }, undefined, "other/app", "b")).revision).toBe(1);
});

it("R5 raw own __proto__ JSON round-trips without changing prototypes or opaque values", async () => {
	const s = await fixture();
	const payload = JSON.parse(
		'{"ordinary":"keep","__proto__":{"note":"opaque"},"nested":{"__proto__":["preserved",null]}}',
	);
	const state = await s.write({ payload });
	expect(JSON.stringify(state.payload)).toBe(JSON.stringify(payload));
	expect(Object.hasOwn(state.payload as object, "__proto__")).toBe(true);
	expect(Object.getPrototypeOf(state.payload)).toBe(Object.prototype);
	expect(JSON.stringify((await s.read()).payload)).toBe(JSON.stringify(payload));
});

it("R5 oversized original __proto__ JSON is rejected before discarded fields could bypass the UTF-8 cap", async () => {
	const s = await fixture();
	const previous = await s.write({ payload: { summary: "preserved" } });
	const payload = JSON.parse(`{"ordinary":"keep","__proto__":{"note":"${"x".repeat(17_000)}"}}`);
	expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeGreaterThan(16_384);
	const before = await s.stored();
	await expect(s.write({ revision: previous.revision, payload })).rejects.toMatchObject({
		status: 400,
		code: "payload_too_large",
	});
	expect(await s.stored()).toEqual(before);
});

it("R5 accepts depth 64 and rejects small depth 65/1001 payloads with controlled 400 before any D1 statement", async () => {
	const s = await fixture();
	const nested = (depth: number) => JSON.parse(`${'{"x":'.repeat(depth)}null${"}".repeat(depth)}`);
	const accepted = await s.write({ payload: nested(64) });
	expect(accepted.payload).toEqual(nested(64));
	const before = await s.stored();
	for (const depth of [65, 1001]) {
		const payload = nested(depth);
		expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(16_384);
		const db = createDb(s.raw);
		await expect(
			writeRepoAgentState(db, "a", "owner/app", { revision: accepted.revision, payload }, "actor"),
		).rejects.toMatchObject({ status: 400, code: "invalid_payload" });
		expect(db.statements).toBe(0);
		expect(await s.stored()).toEqual(before);
	}
});
