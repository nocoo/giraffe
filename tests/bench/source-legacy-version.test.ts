import { afterAll, beforeAll, expect, it } from "bun:test";
import type { Env } from "../../apps/web/src/server/env";
import { createApp } from "../../apps/web/src/server/index";
import { createApiToken } from "../../apps/web/src/server/lib/api-tokens";
import { createDb } from "../../apps/web/src/server/lib/db/d1";
import { readObservation } from "../../apps/web/src/server/lib/machine-observations";
import { readSources } from "../../apps/web/src/server/lib/machine-sources";
import { revisionFixture } from "../fixtures/revision";
import { sqliteFixture } from "../fixtures/sqlite";

const revision = revisionFixture("6f87d669eb67d92d1ad8a404c8a1fa0e4ffcf3b3");
let baselineApp: typeof import("../../apps/web/src/server/index");
let baselineSources: typeof import("../../apps/web/src/server/lib/machine-sources");
let baselineObservations: typeof import("../../apps/web/src/server/lib/machine-observations");
let baselineContent: typeof import("../../apps/web/src/server/lib/content-version");
const originalFetch = globalThis.fetch;
const denyNetwork = () => {
	throw new Error("legacy-version comparison forbids network");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

beforeAll(async () => {
	[baselineApp, baselineSources, baselineObservations, baselineContent] = await Promise.all([
		revision.load<typeof baselineApp>("apps/web/src/server/index.ts"),
		revision.load<typeof baselineSources>("apps/web/src/server/lib/machine-sources.ts"),
		revision.load<typeof baselineObservations>("apps/web/src/server/lib/machine-observations.ts"),
		revision.load<typeof baselineContent>("apps/web/src/server/lib/content-version.ts"),
	]);
});
afterAll(() => {
	globalThis.fetch = originalFetch;
	revision.close();
});

async function setup(cached: boolean) {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const account = "legacy-version-account";
	const fetchedAt = "2026-10-20T00:00:00.000Z";
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'owner','fake','fake',?,?)",
		)
		.bind(account, fetchedAt, fetchedAt)
		.run();
	const pullRequests = [
		{ number: 1 },
		{ number: 2, state: "OPEN" },
		{ number: 3, state: null },
		{ number: 4, state: "closed", merged_at: fetchedAt },
		{ number: 5, state: "unknown" },
	].map((row) => ({ ...row, name_with_owner: "owner/app" }));
	for (const [kind, data] of Object.entries({
		repos: {
			repos: [{ name_with_owner: "owner/app", is_archived: false, is_fork: false }],
		},
		prs: { pull_requests: pullRequests },
		"repo:owner/app:prs": { pull_requests: pullRequests },
	})) {
		const payload = { ...data, fetched_at: fetchedAt, truncated: false };
		await raw
			.prepare(
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?)",
			)
			.bind(
				account,
				kind,
				JSON.stringify(payload),
				fetchedAt,
				cached ? await baselineContent.savedContentMeta(kind, payload) : null,
			)
			.run();
	}
	const token = await createApiToken(db, {
		accountId: account,
		label: "legacy-version-fixture",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	const env = { DB: raw, ENVIRONMENT: "development" } as unknown as Env;
	const request = (app: ReturnType<typeof createApp>, match?: string) =>
		app.request(
			`http://localhost/api/v1/accounts/${account}/sources`,
			{
				headers: {
					Authorization: `Bearer ${token.token}`,
					...(match ? { "If-None-Match": match } : {}),
				},
			},
			env,
		);
	return { raw, db, account, request };
}

it.each([false, true])(
	"preserves post-r3 source indexes and conditional tags over unchanged legacy rows (cached=%s)",
	async (cached) => {
		const fixture = await setup(cached);
		const before = await fixture.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		for (const query of [{}, { repository: "OWNER/APP" }, { since: "2026-10-19T00:00:00Z" }]) {
			const old = await baselineSources.readSources(fixture.db, fixture.account, query);
			const current = await readSources(fixture.db, fixture.account, query);
			expect(JSON.stringify(current)).toBe(JSON.stringify(old));
		}
		const old = await fixture.request(baselineApp.createApp());
		const current = await fixture.request(createApp());
		expect(old.status).toBe(200);
		expect(current.status).toBe(200);
		expect(current.headers.get("etag")).toBe(old.headers.get("etag"));
		expect(await current.text()).toBe(await old.text());
		const etag = old.headers.get("etag");
		if (!etag) throw new Error("missing baseline etag");
		expect((await fixture.request(createApp(), etag)).status).toBe(304);
		expect(await fixture.raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(
			before,
		);
	},
);

it.each([false, true])(
	"preserves post-r3 observation versions independently of lifecycle presentation (cached=%s)",
	async (cached) => {
		const fixture = await setup(cached);
		for (const resource of ["prs", "repo:owner/app:prs"]) {
			const old = await baselineObservations.readObservation(
				fixture.db,
				fixture.account,
				resource,
				"all",
			);
			const current = await readObservation(fixture.db, fixture.account, resource, "all");
			expect(current.sourceVersion).toBe(old.sourceVersion);
			expect(current.contentVersion).toBe(old.contentVersion);
			expect(current.data.pull_requests).toMatchObject([
				{ state: null },
				{ state: "open" },
				{ state: null },
				{ state: "merged" },
				{ state: null },
			]);
		}
	},
);
