import { expect, it } from "vitest";

import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { savedContentMeta, storedContent } from "../lib/content-version";
import { createDb } from "../lib/db/d1";
import { readRepositorySnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";

const at = "2026-10-21T00:00:00.000Z";
const kind = "repo:owner/app:security";
const available = { status: "available", reason_code: null, reason: null };
const partial = { ...available, status: "partial" };

async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','owner','fake','fake',1,?,?)",
		)
		.bind(at, at)
		.run();
	await db.batch(
		await replaceSnapshotStmts(db, "a", "repos", { repos: [{ name_with_owner: "owner/app" }] }, at),
	);
	const token = await createApiToken(db, {
		accountId: "a",
		label: "local security test",
		scopes: ["observations:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	const app = createApp();
	const request = async (lane: "browser" | "machine") => {
		const path =
			lane === "browser"
				? "/api/repos/owner/app/security"
				: "/api/v1/accounts/a/repos/owner/app/security";
		const response = await app.request(
			`http://localhost${path}`,
			lane === "machine" ? { headers: { Authorization: `Bearer ${token.token}` } } : {},
			{
				DB: raw,
				ENVIRONMENT: "development",
				GITHUB_API_BASE: "http://127.0.0.1:17046",
			} as Env,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		return { body, data: lane === "browser" ? body : (body.data as Record<string, unknown>) };
	};
	return { db, request };
}

it.each(["browser", "machine"] as const)(
	"corrects legacy truncated repository security presentation without rewriting evidence on %s reads",
	async (lane) => {
		const { db, request } = await setup();
		const unavailable = {
			status: "unavailable",
			reason_code: "not_found",
			reason: "Not found",
		};
		const legacy = {
			fetched_at: at,
			truncated: true,
			unavailable: false,
			items: [{ source: "code_scanning", number: 1 }],
			dependabot_open: null,
			code_scanning_open: 100,
			features: { dependabot: unavailable, code_scanning: available },
		};
		const metadata = await savedContentMeta(kind, legacy);
		await db
			.prepare(
				"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES('a',?,?,?,?)",
			)
			.bind(kind, JSON.stringify(legacy), at, metadata)
			.run();
		const before = await db.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all();
		const { body, data } = await request(lane);
		expect(data).toMatchObject({
			truncated: true,
			code_scanning_open: 100,
			features: { dependabot: unavailable, code_scanning: partial },
		});
		const saved = (await readRepositorySnapshot(db, "a", kind))?.data;
		expect(storedContent(saved)).toEqual(JSON.parse(metadata));
		if (lane === "machine") {
			expect(body.sourceVersion).toBe(JSON.parse(metadata).fullVersion);
			expect(body.contentVersion).toBe(JSON.parse(metadata).hash);
		}
		expect(await db.prepare("SELECT * FROM refresh_snapshots ORDER BY kind").all()).toEqual(before);
	},
);
