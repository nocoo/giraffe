import { describe, expect, it } from "vitest";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { contentVersion } from "../content-version";
import { insertAccountStmt } from "./accounts";
import { createDb } from "./d1";
import { readSnapshot, replaceSnapshotStmts } from "./snapshots";
import { openSqliteD1 } from "./sqlite-d1";

describe("snapshots store", () => {
	it("persists one content hash for the retained pages without changing payloads", async () => {
		const db = createDb(sqliteFixture());
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('hash','hash','fixture','fake','t','t')",
			)
			.run();
		const payload = {
			truncated: false,
			repos: [1, 2, 3].map((id) => ({ id, description: "x".repeat(800_000) })),
		};
		await db.batch(await replaceSnapshotStmts(db, "hash", "repos", payload, "first"));
		const saved = await readSnapshot(db, "hash", "repos");
		if (!saved) throw new Error("missing snapshot");
		expect(saved.repos).toHaveLength(2);
		expect(saved.truncated).toBe(true);
		const rows = await db
			.prepare("SELECT content_meta,payload FROM snapshots WHERE account_id='hash' ORDER BY kind")
			.all<{ content_meta: string; payload: string }>();
		expect(rows.results).toHaveLength(2);
		for (const row of rows.results) {
			expect(JSON.parse(row.content_meta)).toEqual({
				hash: await contentVersion("repos", saved),
				fullVersion: `sha256:${createHash("sha256").update(JSON.stringify(saved)).digest("hex")}`,
			});
			expect(JSON.parse(row.payload)).not.toHaveProperty("content_meta");
		}
		await db.batch(await replaceSnapshotStmts(db, "hash", "repos", payload, "second"));
		const refreshed = await db
			.prepare("SELECT content_meta FROM snapshots WHERE account_id='hash' ORDER BY kind")
			.all<{ content_meta: string }>();
		expect(refreshed.results.map((row) => JSON.parse(row.content_meta).hash)).toEqual(
			rows.results.map((row) => JSON.parse(row.content_meta).hash),
		);
		expect(refreshed.results.map((row) => JSON.parse(row.content_meta).fullVersion)).not.toEqual(
			rows.results.map((row) => JSON.parse(row.content_meta).fullVersion),
		);
	});

	it("binds saved factory content metadata to its original stream version", async () => {
		const db = createDb(sqliteFixture());
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('hash','hash','fixture','fake','t','t')",
			)
			.run();
		await db.batch(
			await replaceSnapshotStmts(
				db,
				"hash",
				"factory:owner/repo:commits",
				{ runId: "original", items: [], coverage: { fetchedAt: "old" } },
				"new",
			),
		);
		const row = await db
			.prepare("SELECT content_meta FROM snapshots WHERE account_id='hash'")
			.first<{ content_meta: string }>();
		expect(JSON.parse(row?.content_meta ?? "null")).toMatchObject({
			hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			version: "original",
		});
	});

	it("replaces pages in two statements and reads them back", async () => {
		const db = createDb(openSqliteD1());
		await db.batch([
			insertAccountStmt(db, {
				id: "1",
				login: "o",
				avatar_url: "",
				token_ciphertext: "{}",
				token_last4: "AAAA",
				key_version: 1,
				scopes: "",
				capabilities: "{}",
				is_active: 1,
				created_at: "t",
				updated_at: "t",
				last_used_at: null,
			}),
		]);
		await db.batch(
			await replaceSnapshotStmts(
				db,
				"1",
				"repos",
				{ truncated: false, repos: [{ n: 1 }] },
				"2026-09-01T00:00:00.000Z",
			),
		);
		const snap = await readSnapshot(db, "1", "repos");
		expect(snap?.repos).toEqual([{ n: 1 }]);
		expect(await readSnapshot(db, "1", "issues")).toBeNull();
	});
});

import { createHash } from "node:crypto";
