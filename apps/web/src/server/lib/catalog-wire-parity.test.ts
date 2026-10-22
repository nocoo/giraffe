import { expect, it } from "vitest";
import baseline from "../../../../../tests/fixtures/catalog-wire-r4.json";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { mapRepos } from "./github-map";
import { readObservation } from "./machine-observations";

const historyFields = ["first_seen_at", "last_seen_at", "removed_at", "archived_changed_at"];

it.each(["all", "starred"] as const)(
	"R7 pinned-R4 cross-version fixture preserves every non-history repository wire field for scope=%s",
	async (scope) => {
		const raw = sqliteFixture();
		const db = createDb(raw);
		const at = "2026-10-21T20:00:00.000Z";
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake',?,?)",
			)
			.bind(at, at)
			.run();
		const rows = mapRepos([
			{
				...rawRepo,
				name: "app",
				stargazerCount: 17,
				forkCount: 2,
				isArchived: true,
				isFork: true,
				visibility: "PRIVATE",
			},
			{
				...rawRepo,
				id: "R_2",
				name: "second",
				nameWithOwner: "nocoo/second",
				url: "https://github.com/nocoo/second",
				isPrivate: false,
				visibility: "PUBLIC",
			},
		]);
		await db.batch(
			await replaceSnapshotStmts(db, "a", "repos", { repos: rows, truncated: false }, at),
		);
		await db
			.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at,reason) VALUES('a','nocoo/app',1,'owner',?,'manual choice')",
			)
			.bind(at)
			.run();
		const saved = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
		const old = baseline.observations[scope];
		const current = await readObservation(db, "a", "repos", scope);
		const currentRepos = current.data.repos as Record<string, unknown>[];
		const stripHistory = (repo: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(repo).filter(([key]) => !historyFields.includes(key)));
		expect(currentRepos.map(stripHistory)).toEqual(old.repos);
		for (const field of [
			"fetchedAt",
			"freshness",
			"coverage",
			"truncated",
			"unavailable",
			"source",
			"selection",
		] as const)
			expect(current[field]).toEqual(old[field]);
		for (const repo of currentRepos)
			for (const field of historyFields) {
				expect(repo).toHaveProperty(field);
				expect(repo[field] === null || typeof repo[field] === "string").toBe(true);
			}
		expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(saved);
	},
);
