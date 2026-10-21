import { expect, it, vi } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import { readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";

it("filters every repository source and factory inventory against the current catalog without deleting history", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snap = factoryFixture();
	const account = snap.account_id;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake','t','t')",
		)
		.bind(account)
		.run();
	const save = (kind: string, value: Record<string, unknown>) =>
		db.batch(replaceSnapshotStmts(db, account, kind, value, snap.fetched_at));
	await save("repos", { repos: [{ name_with_owner: "nocoo/app" }] });
	for (const name of ["NOCOO/APP", "nocoo/removed"])
		for (const suffix of ["details", "issues", "prs", "actions", "releases"])
			await save(`repo:${name}:${suffix}`, {
				runs: [],
				issues: [],
				pull_requests: [],
				releases: [],
			});
	const first = snap.repos[0];
	if (!first) throw new Error("fixture");
	snap.repos.push({ ...first, name: "nocoo/removed" });
	snap.inventory.excluded.push({ name: "nocoo/removed", reason: "fork" });
	await save("factory", snap);
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	const fetchSpy = vi.spyOn(globalThis, "fetch");
	try {
		const sources = await readSources(createDb(raw), account, {});
		expect(sources.sources.some((source) => source.resource.includes("removed"))).toBe(false);
		expect(sources.sources.filter((source) => source.resource.startsWith("repo:"))).toHaveLength(5);
		expect(
			(await readSources(createDb(raw), account, { repository: "NOCOO/APP" })).sources.filter(
				(source) => source.resource.startsWith("repo:"),
			),
		).toHaveLength(5);
		const factory = await readObservation(db, account, "factory", "all");
		expect(factory.data.repos).toHaveLength(1);
		expect(factory.data.inventory).toMatchObject({ excluded: [] });
		expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
		expect(fetchSpy).not.toHaveBeenCalled();
	} finally {
		fetchSpy.mockRestore();
	}
});
