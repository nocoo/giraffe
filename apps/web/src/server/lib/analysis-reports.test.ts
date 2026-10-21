import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createResource, getResource, listResources, updateResource } from "./agent-resources";
import { readAnalysisReports } from "./analysis-reports";
import { createDb } from "./db/d1";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','a','fake','fake','t','t'),('b','b','fake','fake','t','t')",
		)
		.run();
	return { raw, db: createDb(raw) };
}

it.each([6001, 60001])(
	"seeks three rows per key across %i reports without historical payload reads",
	async (history) => {
		const { raw, db } = await fixture();
		await raw
			.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${history})
			INSERT INTO agent_resources(account_id,collection,id,repository,type,status,source_version,payload,created_at,updated_at)
			SELECT 'a','reports',printf('history-%05d',i),'nocoo/app','github-analysis','completed','v1',
			json_object('scope','repo','domain','prs','generatedAt',strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01',printf('+%d seconds',i)),
			'summary',printf('%01024d',i)),'t','t' FROM n`)
			.run();
		const prepare = vi.spyOn(db, "prepare");
		const result = await readAnalysisReports(db, "a");
		expect(result.account_id).toBe("a");
		expect(result.items.map((row) => row.id)).toEqual(
			[history, history - 1, history - 2].map((n) => `history-${String(n).padStart(5, "0")}`),
		);
		expect(db.statements).toBe(1);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(5000);
		const sql = prepare.mock.calls[0]?.[0];
		expect(sql).toBeTruthy();
		const plan = await raw
			.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.bind("a", "a", "a")
			.all<{ detail: string }>();
		const details = plan.results.map((row) => row.detail).join("\n");
		expect(details).toContain("agent_analysis_recent");
		expect(details).toContain("<expr>>?");
		expect(details).toContain("<expr>=?");
		expect(details).toContain("SEARCH r USING INTEGER PRIMARY KEY (rowid=?)");
		expect(details).not.toMatch(/SCAN (?:r|agent_resources)\b/);
		expect(details.match(/TEMP B-TREE/g)).toHaveLength(1);
		const code = await raw
			.prepare(`EXPLAIN ${sql}`)
			.bind("a", "a", "a")
			.all<{ opcode: string; p1: number; p2: number }>();
		const table = await raw
			.prepare("SELECT rootpage FROM sqlite_master WHERE name='agent_resources'")
			.first<{ rootpage: number }>();
		const tableCursors = new Set(
			code.results
				.filter((op) => op.opcode === "OpenRead" && op.p2 === table?.rootpage)
				.map((op) => op.p1),
		);
		const hydration = code.results.find((op) => op.opcode === "SeekRowid");
		expect(hydration).toBeDefined();
		expect(
			new Set(
				code.results
					.filter((op) => op.opcode === "Column" && tableCursors.has(op.p1))
					.map((op) => op.p1),
			),
		).toEqual(new Set([hydration?.p1]));
		expect(await raw.prepare("SELECT COUNT(*) AS n FROM agent_resources").first()).toEqual({
			n: history,
		});
		const generic = await listResources(db, "a", "reports", { limit: 3 });
		expect(generic.items.map((row) => row.id)).toEqual([
			"history-00001",
			"history-00002",
			"history-00003",
		]);
		expect(generic.nextCursor).toBe("history-00003");
	},
);

it("isolates accounts, collection, type and each exact scope/repository/domain key", async () => {
	const { db } = await fixture();
	for (const account of ["a", "b"])
		for (const [scope, repository, domain] of [
			["repo", "nocoo/app", "prs"],
			["repo", "nocoo/other", "prs"],
			["repo", "nocoo/app", "issues"],
			["global", null, "prs"],
			["global", "nocoo/app", "prs"],
		] as const)
			for (let i = 0; i < 4; i++)
				await createResource(db, account, "reports", {
					id: `${scope}-${repository?.split("/")[1] ?? "all"}-${domain}-${i}`,
					repository,
					type: "github-analysis",
					status: i === 3 ? "pending" : "completed",
					payload: { scope, repository, domain, generatedAt: "2026-10-21T00:00:00Z" },
				});
	for (const [collection, type] of [
		["reports", "other"],
		["records", "github-analysis"],
		["jobs", "github-analysis"],
	] as const)
		await createResource(db, "a", collection, { type, status: "completed", payload: {} });
	const beforeRead = db.statements;
	const result = await readAnalysisReports(db, "a");
	expect(db.statements - beforeRead).toBe(1);
	expect(result.items).toHaveLength(15);
	expect(result.items.every((row) => row.account_id === "a")).toBe(true);
	expect(result.items.filter((row) => row.status === "pending")).toHaveLength(5);
	expect(result.items.every((row) => !row.id.endsWith("-0"))).toBe(true);
	expect(result.items.map((row) => row.id)).toContain("global-app-prs-3");
	expect(await readAnalysisReports(db, "missing")).toEqual({ account_id: "missing", items: [] });
});

it("orders actual generation instants, breaks ties by descending id and ignores edit time", async () => {
	const { db } = await fixture();
	for (const [id, generatedAt] of [
		["a", "2026-10-21T10:00:00+08:00"],
		["z", "2026-10-21T02:00:00Z"],
		["new", "2026-10-21T02:00:01Z"],
		["old", "2026-10-21T01:59:59Z"],
		["bad", "invalid"],
	] as const)
		await createResource(db, "a", "reports", {
			id,
			type: "github-analysis",
			status: "completed",
			payload: { scope: "global", domain: "ci", generatedAt },
		});
	await updateResource(db, "a", "reports", "old", { revision: 1, status: "failed" });
	expect((await readAnalysisReports(db, "a")).items.map((row) => row.id)).toEqual([
		"new",
		"z",
		"a",
	]);
	await updateResource(db, "a", "reports", "old", {
		revision: 2,
		payload: { scope: "repo", domain: "cd", generatedAt: "2026-10-22T00:00:00Z" },
	});
	expect((await readAnalysisReports(db, "a")).items).toHaveLength(4);
	expect(await getResource(db, "a", "reports", "bad")).not.toBeNull();
	await createResource(db, "a", "reports", {
		id: "malformed",
		type: "github-analysis",
		status: "pending",
		payload: { oldReport: true },
	});
	expect((await readAnalysisReports(db, "a")).items.map((row) => row.id)).toContain("malformed");
});

it("adds the index repeatably without rewriting rows and preserves old CRUD on rollback", async () => {
	const { raw, db } = await fixture();
	await createResource(db, "a", "reports", {
		id: "legacy",
		type: "github-analysis",
		status: "completed",
		payload: { scope: "global", domain: "issues", generatedAt: "2026-10-21T00:00:00Z" },
	});
	await raw.prepare("DROP INDEX IF EXISTS agent_analysis_recent").run();
	await raw
		.prepare("UPDATE agent_resources SET payload=json_set(payload,'$.generatedAt','now')")
		.run();
	const before = await raw.prepare("SELECT * FROM agent_resources").all();
	const migration = readFileSync("migrations/0015_analysis_reports.sql", "utf8");
	expect(readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8").endsWith(migration)).toBe(
		true,
	);
	await raw.prepare(migration).run();
	await raw.prepare(migration).run();
	expect(await raw.prepare("SELECT * FROM agent_resources").all()).toEqual(before);
	await updateResource(db, "a", "reports", "legacy", { revision: 1, payload: { legacy: true } });
	expect((await getResource(db, "a", "reports", "legacy"))?.payload).toEqual({ legacy: true });
	expect(await raw.prepare("PRAGMA integrity_check").first()).toEqual({ integrity_check: "ok" });
	expect((await raw.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("preserves generic CRUD for malformed and relative generation times", async () => {
	const { db } = await fixture();
	for (const [i, generatedAt] of ["now", "subsec", "subsecond", null, 123].entries())
		await createResource(db, "a", "reports", {
			id: `invalid-${i}`,
			type: "github-analysis",
			status: "pending",
			payload: { scope: "global", domain: "issues", generatedAt },
		});
	expect((await readAnalysisReports(db, "a")).items.map((row) => row.id)).toEqual([
		"invalid-4",
		"invalid-3",
		"invalid-2",
	]);
});

it("migrates schema-accepted JSON deeper than JSON1 can inspect without changing rows", async () => {
	const { raw, db } = await fixture();
	await raw.prepare("DROP INDEX agent_analysis_recent").run();
	const payload = JSON.parse(
		`{"scope":"global","domain":"prs","generatedAt":"2026-10-21T00:00:00Z","extension":${"[".repeat(1000)}0${"]".repeat(1000)}}`,
	);
	await createResource(db, "a", "reports", {
		id: "deep",
		type: "github-analysis",
		status: "completed",
		payload,
	});
	const before = await raw.prepare("SELECT * FROM agent_resources").all();
	expect(
		await raw.prepare("SELECT json_valid(payload) AS valid FROM agent_resources").first(),
	).toEqual({ valid: 0 });
	const migration = readFileSync("migrations/0015_analysis_reports.sql", "utf8");
	await raw.prepare(migration).run();
	await raw.prepare(migration).run();
	expect(await raw.prepare("SELECT * FROM agent_resources").all()).toEqual(before);
	expect((await readAnalysisReports(db, "a")).items).toMatchObject([{ id: "deep", payload }]);
	await updateResource(db, "a", "reports", "deep", { revision: 1, payload });
	expect((await getResource(db, "a", "reports", "deep"))?.revision).toBe(2);
	expect(await raw.prepare("PRAGMA integrity_check").first()).toEqual({ integrity_check: "ok" });
});
