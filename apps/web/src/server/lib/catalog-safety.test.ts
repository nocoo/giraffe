import { expect, it } from "vitest";
import {
	before,
	fixture,
	later,
	missing,
	now,
	proof,
	safeNotFound,
} from "../../../../../tests/fixtures/catalog-safety";
import { github } from "../../../../../tests/fixtures/factory";
import { beginCatalog, catalogSnapshot, planCatalog } from "./catalog-history";
import { readCatalogChanges } from "./catalog-read";
import { createDb } from "./db/d1";
import { factoryStorage, pruneFactory } from "./factory-retention";
import { MAX_FETCHES } from "./github-client";

it("R7 safety GraphQL endpoint HTTP 404 Not Found never proves the queried node absent", async () => {
	const context = await fixture();
	const { result } = await context.plan(() =>
		Response.json({ message: "Not Found" }, { status: 404 }),
	);
	expect(result.removed).toEqual([]);
	await context.publish(result);
	expect(await context.saved()).toEqual(context.original);
	expect(
		(await readCatalogChanges(context.db, "a", { since: [before] })).unconfirmed,
	).toMatchObject([{ reason: "lookup_unverifiable" }]);
});

it.each([
	{ data: {}, path: ["node"] },
	{ data: { node: {} }, path: ["node"] },
	{ data: { node: null }, path: ["repository"] },
	{ data: { node: null }, path: ["node", "id"] },
	{ data: { node: null }, path: undefined },
])(
	"R7 safety only exact node-level null and positive NOT_FOUND authorizes cleanup: %j",
	async ({ data, path }) => {
		const context = await fixture();
		const { result } = await context.plan(() =>
			Response.json({ data, errors: [{ type: "NOT_FOUND", message: "Not Found", path }] }),
		);
		expect(result.removed).toEqual([]);
		await context.publish(result);
		expect(await context.saved()).toEqual(context.original);
	},
);

it.each([
	[401, "Bad credentials"],
	[403, "Resource not accessible by personal access token"],
	[404, "Resource not accessible by personal access token"],
	[404, "SAML SSO enforcement requires authorization"],
	[429, "Rate limit exceeded"],
	[503, "Unavailable"],
] as const)(
	"R7 safety persists unconfirmed lookup %s without clearing mutable state",
	async (status, message) => {
		const context = await fixture();
		const { result, requests } = await context.plan(() => Response.json({ message }, { status }));
		expect(result.removed).toEqual([]);
		expect(result.warning).toBe("catalog_removal_unconfirmed");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.variables).toEqual({ id: "R_OLD" });
		expect(requests[0]?.query).toContain("node(id:");
		await context.publish(result);
		expect(await context.saved()).toEqual(context.original);
		expect(await readCatalogChanges(context.db, "a", { since: [before] })).toMatchObject({
			removed: [],
			unconfirmed: [
				{
					repo: "nocoo/old",
					github_id: "R_OLD",
					at: now,
					reason: expect.any(String),
					source: { kind: "legacy", runId: null },
				},
			],
		});
	},
);

it.each([true, false])(
	"R7 safety private=%s never attempts removal without private visibility proof",
	async (isPrivate) => {
		const context = await fixture(isPrivate, false);
		const { result, requests } = await context.plan(safeNotFound);
		expect(requests).toEqual([]);
		expect(result.removed).toEqual([]);
		await context.publish(result);
		expect(await context.saved()).toEqual(context.original);
		expect(await readCatalogChanges(context.db, "a", { since: [before] })).toMatchObject({
			unconfirmed: [{ reason: isPrivate ? "private_unverifiable" : "scope_unverifiable" }],
		});
	},
);

it("R7 safety public-to-private loss of scope and unrelated new private identity are not proof", async () => {
	const context = await fixture();
	const { result, requests } = await context.plan(safeNotFound, [proof], {
		"nocoo/private-proof": "R_DIFFERENT_PRIVATE",
	});
	expect(requests).toEqual([]);
	expect(result.removed).toEqual([]);
	await context.publish(result);
	expect((await readCatalogChanges(context.db, "a", { since: [before] })).unconfirmed).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ repo: "nocoo/old", reason: "scope_unverifiable" }),
		]),
	);
});

it.each([
	() => Response.json({ data: { node: null } }),
	() => Response.json({ data: { node: {} } }),
	() => Response.json({ data: { node: { id: "R_OTHER", nameWithOwner: "nocoo/old" } } }),
	() =>
		Response.json({
			data: { node: null },
			errors: [{ type: "NOT_FOUND", message: "Repository cannot be viewed", path: ["node"] }],
		}),
	() => Promise.reject(new Error("fixture network failure")),
])(
	"R7 safety null malformed ambiguous or failed node reads never authorize deletion",
	async (response) => {
		const context = await fixture();
		const { result } = await context.plan(response);
		expect(result.removed).toEqual([]);
		await context.publish(result);
		expect(await context.saved()).toEqual(context.original);
		expect(
			(await readCatalogChanges(context.db, "a", { since: [before] })).unconfirmed,
		).toHaveLength(1);
	},
);

it("R7 safety positively proven stable-ID absence removes only public candidates", async () => {
	const context = await fixture();
	const { result } = await context.plan(safeNotFound);
	expect(result.removed).toEqual(["nocoo/old"]);
	await context.publish(result);
	expect((await context.saved()).map((value) => value.results)).toEqual([[], [], []]);
	expect(await readCatalogChanges(context.db, "a", { since: [before] })).toMatchObject({
		removed: [{ github_id: "R_OLD" }],
		unconfirmed: [],
	});
});

it("R7 safety stable-ID lookup discovers rename rather than looking up the old name", async () => {
	const context = await fixture();
	const { result, requests } = await context.plan(() =>
		Response.json({ data: { node: { id: "R_OLD", nameWithOwner: "nocoo/renamed" } } }),
	);
	expect(requests[0]?.variables).toEqual({ id: "R_OLD" });
	expect(result.renames).toEqual([{ from: "nocoo/old", to: "nocoo/renamed" }]);
	await context.publish(result);
	expect(
		await context.raw.prepare("SELECT repo,starred,reason FROM repo_stars").all(),
	).toMatchObject({ results: [{ repo: "nocoo/renamed", starred: 0, reason: "keep tombstone" }] });
});

it.each([false, true])(
	"R7 safety single-run replacement and repeat preserve old state independently (confirmed=%s)",
	async (confirmed) => {
		const context = await fixture();
		const rows = [proof, missing];
		const ids = { "nocoo/private-proof": "R_PROOF", "nocoo/old": "R_NEW" };
		const response = confirmed ? safeNotFound : () => Response.json({ data: { node: null } });
		const first = await context.plan(response, rows, ids);
		expect(
			first.result.events.filter((event) => event.kind === "added").map((event) => event.github_id),
		).toEqual(["R_NEW"]);
		await context.publish(first.result);
		expect(catalogSnapshot(first.result).repos).toHaveLength(2);
		expect(
			await context.raw
				.prepare(
					"SELECT github_id,name_current,removed_at,last_seen_at FROM catalog_repositories WHERE github_id='R_OLD'",
				)
				.first(),
		).toEqual({
			github_id: "R_OLD",
			name_current: 0,
			removed_at: confirmed ? now : null,
			last_seen_at: before,
		});
		expect((await context.saved()).map((value) => value.results)).toEqual([[], [], []]);
		expect(
			await context.raw.prepare("SELECT COUNT(*) AS n FROM catalog_displaced_state").first(),
		).toEqual({ n: confirmed ? 0 : 3 });
		const repeated = await context.plan(response, rows, ids, later);
		await context.publish(repeated.result);
		expect(repeated.result.events.filter((event) => event.kind === "added")).toEqual([]);
		expect(catalogSnapshot(repeated.result).repos).toHaveLength(2);
		if (!confirmed) {
			const restored = await context.plan(
				safeNotFound,
				[proof, { ...missing, name_with_owner: "nocoo/restored" }],
				{ "nocoo/private-proof": "R_PROOF", "nocoo/restored": "R_OLD" },
				"2026-10-24T00:00:00.000Z",
			);
			await context.publish(restored.result);
			expect(
				await context.raw
					.prepare("SELECT repo,starred,source,updated_at,reason FROM repo_stars")
					.first(),
			).toEqual({
				repo: "nocoo/restored",
				starred: 0,
				source: "owner",
				updated_at: before,
				reason: "keep tombstone",
			});
			expect(
				await context.raw.prepare("SELECT COUNT(*) AS n FROM catalog_displaced_state").first(),
			).toEqual({ n: 0 });
		}
	},
);

it("R7 safety budget exhaustion persists a specific unconfirmed reason", async () => {
	const context = await fixture();
	const gh = github(() => {
		throw new Error("must not request");
	});
	gh.count = MAX_FETCHES;
	const result = await planCatalog(
		await beginCatalog(context.db, "a"),
		{ repos: [proof], truncated: false },
		{ "nocoo/private-proof": "R_PROOF" },
		"nocoo",
		gh,
		"fixture",
		now,
		{ kind: "factory", runId: "run-proof" },
	);
	await context.publish(result);
	expect(await readCatalogChanges(context.db, "a", { since: [before] })).toMatchObject({
		unconfirmed: [{ reason: "budget_exhausted", source: { kind: "factory", runId: "run-proof" } }],
	});
});

it("R7 safety private candidate never attempts lookup even with valid private proof", async () => {
	const context = await fixture(true);
	const { result, requests } = await context.plan(safeNotFound);
	expect(requests).toEqual([]);
	expect(result.unconfirmed).toMatchObject([
		{ repo: missing.name_with_owner, reason: "private_unverifiable" },
	]);
	await context.publish(result);
	expect(await context.saved()).toEqual(context.original);
});

it.each(["previously_public", "non_owned", "displaced", "identity_missing"] as const)(
	"R7 safety %s private listing does not prove prior owned private access",
	async (mode) => {
		const context = await fixture();
		if (mode === "previously_public")
			await context.raw
				.prepare("UPDATE catalog_repositories SET visibility='PUBLIC' WHERE github_id='R_PROOF'")
				.run();
		if (mode === "non_owned")
			await context.raw
				.prepare(
					"UPDATE catalog_repositories SET repo='other/private-proof' WHERE github_id='R_PROOF'",
				)
				.run();
		if (mode === "displaced")
			await context.raw
				.prepare("UPDATE catalog_repositories SET name_current=0 WHERE github_id='R_PROOF'")
				.run();
		const listed =
			mode === "non_owned" ? { ...proof, name_with_owner: "other/private-proof" } : proof;
		const { result, requests } = await context.plan(
			safeNotFound,
			[listed],
			mode === "identity_missing"
				? {}
				: {
						[listed.name_with_owner]: "R_PROOF",
					},
		);
		expect(requests).toEqual([]);
		expect(result.unconfirmed).toMatchObject([
			{ repo: missing.name_with_owner, reason: "scope_unverifiable" },
		]);
		await context.publish(result);
	},
);

it.each([false, true])(
	"R7 safety resolving quarantined old identity never clears new identity state (confirmed=%s)",
	async (confirmed) => {
		const context = await fixture();
		const rows = [proof, missing];
		const ids = { "nocoo/private-proof": "R_PROOF", "nocoo/old": "R_NEW" };
		const replacement = await context.plan(
			() => Response.json({ data: { node: null } }),
			rows,
			ids,
		);
		await context.publish(replacement.result);
		for (const [table, original] of ["repo_stars", "repo_statistics", "factory_repo_state"].map(
			(table, index) => [table, context.original[index]?.results[0]] as const,
		)) {
			const saved = await context.raw
				.prepare("SELECT payload FROM catalog_displaced_state WHERE table_name=?")
				.bind(table)
				.first<{ payload: string }>();
			expect(saved).not.toBeNull();
			if (table === "factory_repo_state") expect(saved?.payload).toBe(original?.payload);
			else
				expect(JSON.parse(saved?.payload ?? "{}")).toMatchObject(
					Object.fromEntries(
						Object.entries(original ?? {}).filter(([key]) => key !== "account_id"),
					),
				);
		}
		await context.raw
			.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at,reason) VALUES('a','nocoo/old',1,'agent',?,'new identity')",
			)
			.bind(now)
			.run();
		await context.raw.prepare("INSERT INTO repo_statistics VALUES('a','nocoo/old',1)").run();
		await context.raw
			.prepare(
				"INSERT INTO factory_repo_state VALUES('a','nocoo/old','new-version','{\"repo\":\"nocoo/old\",\"new\":true}')",
			)
			.run();
		const newState = await context.saved();
		const resolution = await context.plan(
			confirmed ? safeNotFound : () => Response.json({ data: { node: null } }),
			rows,
			ids,
			later,
		);
		await context.publish(resolution.result);
		expect(await context.saved()).toEqual(newState);
		expect(
			await context.raw.prepare("SELECT COUNT(*) AS n FROM catalog_displaced_state").first(),
		).toEqual({ n: confirmed ? 0 : 3 });
		if (confirmed) {
			const returned = await context.plan(
				() => Response.json({ data: { node: null } }),
				[proof, missing],
				{ "nocoo/private-proof": "R_PROOF", "nocoo/old": "R_OLD" },
				"2026-10-24T00:00:00.000Z",
			);
			await context.publish(returned.result);
			expect(await context.raw.prepare("SELECT * FROM repo_stars").all()).toMatchObject({
				results: [],
			});
		}
	},
);

it("R7 safety large byte-exact quarantined factory state roots original immutable evidence through GC", async () => {
	const context = await fixture();
	const state = JSON.stringify(
		{
			repo: "nocoo/old",
			padding: "x".repeat(20000),
			observation: { source: "run", repo: "nocoo/old", version: "original" },
		},
		null,
		2,
	);
	await context.raw
		.prepare("UPDATE factory_repo_state SET payload=? WHERE repo='nocoo/old'")
		.bind(state)
		.run();
	await context.raw
		.prepare(
			"INSERT INTO factory_repo_versions VALUES('a','nocoo/old','original','{\"id\":\"R_OLD\"}',?)",
		)
		.bind(before)
		.run();
	await context.raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('original','a','original','completed','{}',?,?,?)",
		)
		.bind(before, before, before)
		.run();
	await context.raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('original','nocoo/old','commits','{\"items\":[\"immutable\"]}')",
		)
		.run();
	for (let index = 0; index < 21; index++)
		await context.raw
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'a',?,'completed','{}',?,?,?)",
			)
			.bind(`new-${index}`, `new-${index}`, now, now, now)
			.run();
	const frozenVersions = await context.raw.prepare("SELECT * FROM factory_repo_versions").all();
	const frozenResources = await context.raw.prepare("SELECT * FROM factory_resources").all();
	const first = await context.plan(
		() => Response.json({ data: { node: null } }),
		[proof, missing],
		{ "nocoo/private-proof": "R_PROOF", "nocoo/old": "R_NEW" },
	);
	await context.publish(first.result);
	expect(
		await context.raw
			.prepare(
				"SELECT payload,repo,version FROM catalog_displaced_state WHERE table_name='factory_repo_state'",
			)
			.first(),
	).toEqual({ payload: state, repo: "nocoo/old", version: "original" });
	const storage = await factoryStorage(createDb(context.raw), "a");
	expect(storage.totalBytes).toBeGreaterThan(new TextEncoder().encode(state).length);
	await pruneFactory(createDb(context.raw), "2027-02-01T00:00:00.000Z");
	expect(await context.raw.prepare("SELECT * FROM factory_repo_versions").all()).toEqual(
		frozenVersions,
	);
	expect(await context.raw.prepare("SELECT * FROM factory_resources").all()).toEqual(
		frozenResources,
	);
	expect(
		await context.raw.prepare("SELECT id FROM factory_runs WHERE id='original'").first(),
	).toEqual({ id: "original" });
	const returned = await context.plan(
		() => Response.json({ data: { node: null } }),
		[proof, missing],
		{ "nocoo/private-proof": "R_PROOF", "nocoo/old": "R_OLD" },
		later,
	);
	await context.publish(returned.result);
	expect(
		await context.raw
			.prepare("SELECT payload FROM factory_repo_state WHERE repo='nocoo/old'")
			.first(),
	).toEqual({ payload: state });
});

it("R7 safety legacy unknown stable ID stays unconfirmed despite valid private access proof", async () => {
	const context = await fixture();
	await context.raw
		.prepare("UPDATE catalog_repositories SET github_id=NULL WHERE identity_key='R_OLD'")
		.run();
	const { result, requests } = await context.plan(safeNotFound);
	expect(requests).toEqual([]);
	expect(result.unconfirmed).toMatchObject([{ github_id: null, reason: "identity_unavailable" }]);
	await context.publish(result);
});

it("R7 safety unresolved displaced identities are bounded without pruning uncertain state", async () => {
	const context = await fixture();
	await context.raw
		.prepare(
			"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,is_archived,visibility,is_fork,first_seen_source,name_current) SELECT 'a','displaced-'||value,'R_DISPLACED_'||value,'nocoo/displaced-'||value,'{}',0,'PRIVATE',0,'github_catalog',0 FROM json_each(?)",
		)
		.bind(JSON.stringify(Array.from({ length: 1001 }, (_, index) => index)))
		.run();
	await expect(context.plan(safeNotFound)).rejects.toMatchObject({
		status: 422,
		code: "catalog_capacity",
	});
	expect(
		await context.raw
			.prepare("SELECT COUNT(*) AS n FROM catalog_repositories WHERE name_current=0")
			.first(),
	).toEqual({ n: 1001 });
	expect(await context.saved()).toEqual(context.original);
});
