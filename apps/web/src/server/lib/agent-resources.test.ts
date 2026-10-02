import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import {
	createResource,
	deleteResource,
	getResource,
	listResources,
	updateResource,
} from "./agent-resources";
import { createDb } from "./db/d1";

it("supports account-isolated bounded CRUD with stable IDs and optimistic revisions", async () => {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','a','fake','fake','t','t'),('b','b','fake','fake','t','t')",
		)
		.run();
	for (const sql of readFileSync("migrations/0012_agent_resources.sql", "utf8")
		.split(";")
		.filter((s) => s.trim()))
		await raw.prepare(sql).run();
	const db = createDb(raw);
	const input = {
		id: "stable",
		repository: "nocoo/app",
		type: "github-analysis",
		status: "pending",
		source_version: "v1",
		payload: { domain: "prs" },
	};
	const first = await createResource(db, "a", "reports", input);
	expect(first.revision).toBe(1);
	await expect(createResource(db, "a", "reports", input)).rejects.toMatchObject({ status: 409 });
	expect(await getResource(db, "b", "reports", "stable")).toBeNull();
	expect(
		(await listResources(db, "a", "reports", { limit: 1, type: "github-analysis" })).items,
	).toHaveLength(1);
	expect(
		(await listResources(db, "a", "reports", { repository: "nocoo/other", status: "pending" }))
			.items,
	).toEqual([]);
	const updated = await updateResource(db, "a", "reports", "stable", {
		revision: 1,
		status: "completed",
		payload: { verdict: "pass" },
	});
	expect(updated).toMatchObject({ revision: 2, status: "completed" });
	await expect(
		updateResource(db, "a", "reports", "stable", { revision: 1, status: "failed" }),
	).rejects.toMatchObject({ status: 409 });
	await expect(deleteResource(db, "b", "reports", "stable", 2)).rejects.toMatchObject({
		status: 404,
	});
	await expect(deleteResource(db, "a", "reports", "stable", 1)).rejects.toMatchObject({
		status: 409,
	});
	await deleteResource(db, "a", "reports", "stable", 2);
	expect(await getResource(db, "a", "reports", "stable")).toBeNull();
	await expect(updateResource(db, "a", "reports", "stable", { revision: 2 })).rejects.toMatchObject(
		{ status: 404 },
	);
	for (const bad of [
		{ ...input, payload: { huge: "x".repeat(66000) } },
		{ ...input, type: "" },
		{ ...input, payload: [] },
		{ ...input, extra: true },
	])
		await expect(createResource(db, "a", "reports", bad)).rejects.toMatchObject({ status: 400 });
	await createResource(db, "a", "records", { type: "heartbeat", status: "online", payload: {} });
	await createResource(db, "a", "records", {
		id: "a",
		type: "heartbeat",
		status: "online",
		payload: {},
	});
	const page = await listResources(db, "a", "records", { limit: 1 });
	expect(page.nextCursor).toBeTruthy();
	expect((await listResources(db, "a", "records", { cursor: page.nextCursor })).items).toHaveLength(
		1,
	);
	await expect(listResources(db, "a", "records", { limit: 101 })).rejects.toMatchObject({
		status: 400,
	});
});

it("rejects invalid update bodies and deletion revisions", async () => {
	const db = createDb(sqliteFixture());
	await expect(updateResource(db, "a", "jobs", "x", { revision: 0 })).rejects.toMatchObject({
		status: 400,
	});
	await expect(deleteResource(db, "a", "jobs", "x", 0)).rejects.toMatchObject({ status: 400 });
});
