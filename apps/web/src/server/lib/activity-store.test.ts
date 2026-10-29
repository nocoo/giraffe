import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { readActivity } from "./activity-store";
import { createDb } from "./db/d1";
import { resolveFactoryRunReference } from "./db/factory-runs";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	const run = async (id: string, account = "a", status = "completed") =>
		raw
			.prepare(
				"INSERT INTO refresh_runs(id,account_id,status,trigger,payload,created_at,updated_at) VALUES(?,?,?,'manual','{}','t','t')",
			)
			.bind(id, account, status)
			.run();
	return { raw, db: createDb(raw), run };
}

it("keeps new activity explicitly unavailable without reading retired publications or collecting", async () => {
	const { raw, db, run } = await fixture();
	await run("saved-activity");
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('retired','a','retired','completed','{}','t','t','t')",
		)
		.run();
	await raw
		.prepare(
			"INSERT INTO activity_publications(account_id,run_id,until_at,fetched_at,payload,content_version) VALUES('a','retired','t','t','not-json','retired')",
		)
		.run();
	const fetch = vi.spyOn(globalThis, "fetch");
	try {
		for (const query of [{}, { run: ["saved"] }, { run: ["latest"] }])
			await expect(readActivity(db, "a", query)).rejects.toMatchObject({
				status: 409,
				code: "activity_unpublished",
			});
		expect(fetch).not.toHaveBeenCalled();
		expect((await raw.prepare("SELECT payload FROM activity_publications").all()).results).toEqual([
			{ payload: "not-json" },
		]);
	} finally {
		fetch.mockRestore();
	}
});

it("validates filters, current membership and account-scoped refresh references", async () => {
	const { raw, db, run } = await fixture();
	for (const query of [{ run: ["x", "x"] }, { invalid: ["x"] }, { repository: ["invalid"] }])
		await expect(readActivity(db, "a", query)).rejects.toMatchObject({ status: 400 });
	await expect(readActivity(db, "a", { run: ["missing"] })).rejects.toMatchObject({ status: 404 });
	await expect(readActivity(db, "a", { repository: ["owner/app"] })).rejects.toMatchObject({
		status: 404,
	});
	await raw
		.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at) VALUES('a','R_1','owner/app','2026-10-29','Asia/Shanghai','{}','t')",
		)
		.run();
	await expect(readActivity(db, "a", { repository: ["OWNER/APP"] })).rejects.toMatchObject({
		status: 409,
	});
	await run("saved-one");
	await run("saved-two");
	await expect(resolveFactoryRunReference(db, "a", "saved")).rejects.toMatchObject({ status: 400 });
	expect(await resolveFactoryRunReference(db, "a", "saved-one")).toBe("saved-one");
	expect(await resolveFactoryRunReference(db, "a", "latest")).toBe("latest");
	await expect(resolveFactoryRunReference(db, "other", "saved-one")).rejects.toMatchObject({
		status: 404,
	});
	await expect(resolveFactoryRunReference(db, "a", "saved_")).rejects.toMatchObject({
		status: 404,
	});
	await run("a".repeat(36));
	await run(`${"a".repeat(36)}-tail`);
	expect(await resolveFactoryRunReference(db, "a", "a".repeat(36))).toBe("a".repeat(36));
});
