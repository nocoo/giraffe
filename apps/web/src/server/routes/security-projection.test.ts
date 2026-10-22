import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { prepareRefresh } from "../lib/refresh";

const at = "2026-10-21T00:00:00.000Z";
const available = { status: "available", reason_code: null, reason: null };
const mixed = {
	unavailable: false,
	truncated: false,
	items: [],
	dependabot_open: 0,
	code_scanning_open: null,
	features: {
		dependabot: available,
		code_scanning: { status: "unavailable", reason_code: "not_found", reason: "Not found" },
	},
};

it.each(["all", "starred"])(
	"downgrades collector availability when storage drops security items for %s",
	async (scope) => {
		const fixture = await setup();
		await fixture.save("repos", {
			repos: [{ name_with_owner: "owner/a" }, { name_with_owner: "owner/app" }],
		});
		const db = createDb(fixture.raw);
		const prepared = await prepareRefresh(
			db,
			"a",
			github((url) =>
				url.endsWith("/graphql")
					? Response.json({
							data: {
								repository: {
									vulnerabilityAlerts: {
										nodes: [],
										pageInfo: { hasNextPage: false },
									},
								},
							},
						})
					: Response.json(
							Array.from({ length: url.includes("/owner/a/") ? 100 : 1 }, () => ({
								rule: { description: "x".repeat(30_000) },
							})),
						),
			),
			"fake",
			["alerts"],
			at,
			{},
			{ deriveInsights: false },
		);
		await db.batch(prepared.stmts);
		const raw = await readSnapshot(db, "a", "alerts");
		expect(raw).toMatchObject({ truncated: true, code_scanning_open: 101 });
		const projected = await fixture.request("alerts", scope);
		expect(projected).toMatchObject({
			features: {
				dependabot: { status: "partial" },
				code_scanning: { status: "partial" },
			},
		});
		if (scope === "starred") expect(projected.code_scanning_open).toBeNull();
		else expect(projected.code_scanning_open).toBeGreaterThan(0);
	},
);

async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','owner','fake','fake',1,?,?)",
		)
		.bind(at, at)
		.run();
	const save = async (kind: string, data: Record<string, unknown>, time = at) =>
		db.batch(await replaceSnapshotStmts(db, "a", kind, data, time));
	await save("repos", {
		repos: [{ name_with_owner: "owner/app", open_issue_count: 0, pushed_at: at }],
	});
	await save("issues", { issues: [] });
	await save("insights", { insights: [], alerts_incomplete: true });
	await db.prepare("INSERT INTO repo_stars(account_id,repo) VALUES('a','owner/app')").run();
	const request = async (kind: string, scope: string) => {
		const response = await createApp().request(`http://localhost/api/${kind}?scope=${scope}`, {}, {
			DB: raw,
			ENVIRONMENT: "development",
			GITHUB_API_BASE: "http://127.0.0.1:17046",
		} as Env);
		expect(response.status).toBe(200);
		return response.json() as Promise<Record<string, unknown>>;
	};
	return { raw, save, request };
}

it.each(["all", "starred"])(
	"keeps mixed security incomplete and unavailable counts null on %s browser reads",
	async (scope) => {
		const fixture = await setup();
		await fixture.save("alerts", mixed);
		const before = await fixture.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		expect(await fixture.request("insights", scope)).toMatchObject({ alerts_incomplete: true });
		expect(await fixture.request("alerts", scope)).toMatchObject({
			dependabot_open: 0,
			code_scanning_open: null,
			features: mixed.features,
		});
		expect(await fixture.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(
			before,
		);
	},
);

it.each(["all", "starred"])(
	"retains complete security counts and their original time before a newer mixed page for %s",
	async (scope) => {
		const fixture = await setup();
		await fixture.save("alerts", {
			...mixed,
			features: { dependabot: available, code_scanning: available },
			code_scanning_open: 1,
			items: [{ source: "code_scanning", name_with_owner: "owner/app" }],
		});
		await fixture.save("repo:owner/app:security", mixed, "2026-10-22T00:00:00.000Z");
		expect(await fixture.request("alerts", scope)).toMatchObject({
			code_scanning_open: 1,
			fetched_at: at,
			features: { code_scanning: available },
		});
	},
);

it.each(["all", "starred"])(
	"projects newer complete security instead of unavailable baseline metadata for %s",
	async (scope) => {
		const fixture = await setup();
		await fixture.save("alerts", mixed);
		await fixture.save(
			"repo:owner/app:security",
			{
				...mixed,
				features: { dependabot: available, code_scanning: available },
				code_scanning_open: 1,
				items: [{ source: "code_scanning", name_with_owner: "owner/app" }],
			},
			"2026-10-22T00:00:00.000Z",
		);
		expect(await fixture.request("alerts", scope)).toMatchObject({
			unavailable: false,
			code_scanning_open: 1,
			fetched_at: "2026-10-22T00:00:00.000Z",
			features: { code_scanning: available },
		});
	},
);

it.each(["all", "starred"])(
	"does not treat a mixed repository page as complete evidence for %s insights",
	async (scope) => {
		const fixture = await setup();
		await fixture.save("alerts", { items: [], unavailable: true });
		await fixture.save("repo:owner/app:security", mixed, "2026-10-22T00:00:00.000Z");
		expect(await fixture.request("insights", scope)).toMatchObject({ alerts_incomplete: true });
		expect(await fixture.request("alerts", scope)).toMatchObject({
			dependabot_open: null,
			code_scanning_open: null,
		});
	},
);

it.each(["all", "starred"])(
	"does not infer available zero for a new catalog member from old %s security",
	async (scope) => {
		const fixture = await setup();
		await fixture.save("alerts", {
			...mixed,
			features: { dependabot: available, code_scanning: available },
			code_scanning_open: 0,
		});
		await fixture.save(
			"repos",
			{ repos: [{ name_with_owner: "owner/app" }] },
			"2026-10-22T00:00:00.000Z",
		);
		expect(await fixture.request("alerts", scope)).toMatchObject({
			dependabot_open: null,
			code_scanning_open: null,
			freshness: { missing: 1 },
		});
	},
);

it.each(["all", "starred"])(
	"does not attach root feature metadata to selected legacy evidence for %s",
	async (scope) => {
		const fixture = await setup();
		await fixture.save(
			"repos",
			{ repos: [{ name_with_owner: "owner/app" }] },
			"2026-10-20T00:00:00.000Z",
		);
		await fixture.save("alerts", mixed);
		await fixture.save(
			"repo:owner/app:security",
			{
				items: [{ source: "code_scanning" }],
				dependabot_open: 0,
				code_scanning_open: 1,
			},
			"2026-10-22T12:00:00.000Z",
		);
		const data = await fixture.request("alerts", scope);
		expect(data.code_scanning_open).toBe(1);
		expect(data.features).toBeUndefined();
		expect(data.fetched_at).toBe("2026-10-22T12:00:00.000Z");
	},
);
