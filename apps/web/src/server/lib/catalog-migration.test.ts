import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const migration = readFileSync("migrations/0019_catalog_history.sql", "utf8");
const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");

it("R7 migration ignores malformed catalog entries without rewriting their saved payloads", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(schema.slice(0, schema.indexOf(migration)));
		db.exec(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake','old','old')",
		);
		db.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos',?,'unknown')",
		).run(
			JSON.stringify({ repos: [null, "malformed", 7, {}, { name_with_owner: "nocoo/valid" }] }),
		);
		const saved = db.prepare("SELECT * FROM snapshots").all();
		expect(() => db.exec(migration)).not.toThrow();
		expect(
			db.prepare("SELECT repo,first_seen_at,last_seen_at FROM catalog_repositories").all(),
		).toEqual([{ repo: "nocoo/valid", first_seen_at: null, last_seen_at: null }]);
		expect(db.prepare("SELECT * FROM snapshots").all()).toEqual(saved);
	} finally {
		db.close();
	}
});

it("R7 additive catalog migration seeds saved timestamps without events and preserves legacy rows", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(schema.slice(0, schema.indexOf(migration)));
		db.exec(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake','old','old')",
		);
		db.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos',?,?)",
		).run(
			JSON.stringify({
				repos: [
					{
						name_with_owner: "nocoo/old",
						is_archived: true,
						is_fork: true,
						visibility: "PRIVATE",
						description: "saved",
					},
				],
			}),
			"2026-10-21T12:34:56Z",
		);
		const saved = db.prepare("SELECT * FROM snapshots").all();
		db.exec(migration);
		db.exec(migration);
		expect(
			db
				.prepare(
					"SELECT repo,github_id,first_seen_at,last_seen_at,removed_at,archived_changed_at,first_seen_source,is_archived,is_fork,visibility FROM catalog_repositories",
				)
				.all(),
		).toEqual([
			{
				repo: "nocoo/old",
				github_id: null,
				first_seen_at: "2026-10-21T12:34:56.000Z",
				last_seen_at: "2026-10-21T12:34:56.000Z",
				removed_at: null,
				archived_changed_at: null,
				first_seen_source: "saved_catalog",
				is_archived: 1,
				is_fork: 1,
				visibility: "PRIVATE",
			},
		]);
		expect(db.prepare("SELECT * FROM catalog_changes").all()).toEqual([]);
		expect(db.prepare("SELECT * FROM snapshots").all()).toEqual(saved);
		expect(db.prepare("SELECT checked_at,revision FROM catalog_state").get()).toEqual({
			checked_at: null,
			revision: 0,
		});
	} finally {
		db.close();
	}
});

it.each([false, true])(
	"R7 migration replay after stable-id adoption and rename never conflicts, emits events or resurrects removed membership (removed=%s)",
	(removed) => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(schema.slice(0, schema.indexOf(migration)));
			db.exec(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake','old','old')",
			);
			db.prepare(
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES('a','repos',?,'2026-10-21T00:00:00.000Z')",
			).run(JSON.stringify({ repos: [{ name_with_owner: "nocoo/old" }] }));
			db.exec(migration);
			db.prepare(
				"UPDATE catalog_repositories SET github_id='R_STABLE',repo='nocoo/new',removed_at=? WHERE account_id='a'",
			).run(removed ? "2026-10-22T00:00:00.000Z" : null);
			db.prepare("UPDATE snapshots SET payload=? WHERE account_id='a' AND kind='repos'").run(
				JSON.stringify({ repos: [{ name_with_owner: "nocoo/new" }] }),
			);
			const rows = db.prepare("SELECT * FROM catalog_repositories").all();
			const state = db.prepare("SELECT * FROM catalog_state").all();
			expect(() => db.exec(migration)).not.toThrow();
			expect(db.prepare("SELECT * FROM catalog_repositories").all()).toEqual(rows);
			expect(db.prepare("SELECT * FROM catalog_state").all()).toEqual(state);
			expect(db.prepare("SELECT * FROM catalog_changes").all()).toEqual([]);
			expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			db.close();
		}
	},
);
