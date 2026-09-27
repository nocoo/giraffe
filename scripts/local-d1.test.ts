import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { ensureLocalSchema } from "./local-d1";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execute }));

it.each([false, true])("prepares refresh tables on startup with existing data: %s", (existing) => {
	const db = new DatabaseSync(":memory:");
	try {
		if (existing) {
			const schema = readFileSync("src/server/lib/db/schema.sql", "utf8");
			db.exec(schema.slice(0, schema.indexOf("CREATE TABLE IF NOT EXISTS repo_stars")));
			db.exec(`
				INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at)
				VALUES('fixture','fixture','noncredential','fake','2000','2000');
				INSERT INTO snapshots VALUES('fixture','repos','{"items":[]}','2000');
			`);
		}
		execute.mockImplementation((_bin: string, args: string[]) => {
			expect(args.slice(0, 4)).toEqual(["d1", "execute", "giraffe-db", "--local"]);
			const file = args.find((arg) => arg.startsWith("--file="));
			if (file) {
				db.exec(readFileSync(file.slice("--file=".length), "utf8"));
				return "";
			}
			const query = args[args.indexOf("--command") + 1];
			if (!query) throw new Error("Missing schema query");
			return JSON.stringify([{ results: db.prepare(query).all() }]);
		});
		ensureLocalSchema();
		expect(db.prepare("SELECT * FROM repo_stars").all()).toEqual([]);
		expect(db.prepare("SELECT * FROM refresh_schedules").all()).toEqual([]);
		ensureLocalSchema();
		if (existing) {
			expect(db.prepare("SELECT * FROM snapshots").all()).toEqual([
				{ account_id: "fixture", kind: "repos", payload: '{"items":[]}', fetched_at: "2000" },
			]);
		}
	} finally {
		execute.mockReset();
		db.close();
	}
});
