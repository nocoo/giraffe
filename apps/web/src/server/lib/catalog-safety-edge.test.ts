import { expect, it } from "vitest";
import { fixture, later, missing, now, proof } from "../../../../../tests/fixtures/catalog-safety";
import { rawRepo } from "../../../../../tests/fixtures/factory";
import { makeRun } from "../../lib/factory-run";
import { catalogPlanWrites, catalogRetentionWrites } from "./catalog-history";
import { readCatalogChanges } from "./catalog-read";
import { claimRun, saveRun, startRun } from "./db/factory-runs";
import { newFactory } from "./factory-collect";
import { mapFactoryRepo } from "./factory-map";
import { publicationWrites } from "./factory-publish";

const cutoff = "2026-07-24T00:00:00.000Z";
const expired = "2026-07-23T23:59:59.999Z";
const cohort = "2026-10-01T00:00:00.000Z";
const afterCohort = "2026-10-01T00:00:00.001Z";
const forbidden = () => Response.json({ message: "Permission denied" }, { status: 403 });
type Context = Awaited<ReturnType<typeof fixture>>;

async function history(context: Context) {
	await context.raw
		.prepare("UPDATE catalog_state SET history_since='2026-01-01T00:00:00.000Z',checked_at=?")
		.bind(now)
		.run();
	await context.raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('b','other','fake','fake',?,?)",
		)
		.bind(now, now)
		.run();
	await context.raw
		.prepare(
			"INSERT INTO catalog_state(account_id,history_since,checked_at,revision) VALUES('b','2026-01-01T00:00:00.000Z',?,1)",
		)
		.bind(now)
		.run();
}

async function events(
	context: Context,
	table: "catalog_changes" | "catalog_unconfirmed",
	items: { id: string; at: string }[],
	account = "a",
) {
	const extra = table === "catalog_changes" ? ",kind,details" : ",reason";
	const values = table === "catalog_changes" ? ",'added','{}'" : ",'private_unverifiable'";
	await context.raw
		.prepare(
			`INSERT INTO ${table}(account_id,event_id,repo,github_id,at,source_kind,source_run_id${extra}) SELECT ?,json_extract(value,'$.id'),'nocoo/old','R_OLD',json_extract(value,'$.at'),'factory','evidence-run'${values} FROM json_each(?)`,
		)
		.bind(account, JSON.stringify(items))
		.run();
}

async function state(context: Context) {
	const tables = [
		"catalog_repositories",
		"catalog_state",
		"catalog_changes",
		"catalog_unconfirmed",
		"catalog_displaced_state",
		"repo_stars",
		"repo_statistics",
		"factory_repo_state",
		"snapshots",
		"factory_state",
		"factory_repo_versions",
		"factory_resources",
	];
	return Promise.all(
		tables.map((table) => context.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
	);
}

it("fix1 combined history retains exactly 10000 events across both tables", async () => {
	const context = await fixture();
	await history(context);
	for (const table of ["catalog_changes", "catalog_unconfirmed"] as const)
		await events(
			context,
			table,
			Array.from({ length: 5000 }, (_, index) => ({ id: `${table}-${index}`, at: cohort })),
		);
	await context.db.batch(catalogRetentionWrites(context.db, "a", now));
	const result = await readCatalogChanges(context.db, "a", { since: [cohort] });
	expect(result.added).toHaveLength(5000);
	expect(result.unconfirmed).toHaveLength(5000);
	expect(result.history_since).toBe(cutoff);
	expect(result.unconfirmed[0]).toMatchObject({
		reason: "private_unverifiable",
		source: { kind: "factory", runId: "evidence-run" },
	});
});

it("fix1 combined overflow evicts a timestamp cohort split between tables and preserves other accounts", async () => {
	const context = await fixture();
	await history(context);
	await events(context, "catalog_changes", [
		{ id: "cohort-change", at: cohort },
		...Array.from({ length: 5000 }, (_, index) => ({ id: `new-${index}`, at: now })),
	]);
	await events(context, "catalog_unconfirmed", [
		{ id: "cohort-unconfirmed", at: cohort },
		...Array.from({ length: 4999 }, (_, index) => ({ id: `new-${index}`, at: now })),
	]);
	await events(context, "catalog_changes", [{ id: "foreign-change", at: expired }], "b");
	await events(context, "catalog_unconfirmed", [{ id: "foreign-unconfirmed", at: expired }], "b");
	await context.db.batch(catalogRetentionWrites(context.db, "a", now));
	const result = await readCatalogChanges(context.db, "a", { since: [afterCohort] });
	expect(result.history_since).toBe(afterCohort);
	expect(result.added).toHaveLength(5000);
	expect(result.unconfirmed).toHaveLength(4999);
	await expect(readCatalogChanges(context.db, "a", { since: [cohort] })).rejects.toMatchObject({
		status: 410,
		code: "catalog_history_expired",
	});
	const foreign = await readCatalogChanges(context.db, "b", { since: [expired] });
	expect(foreign.added).toHaveLength(1);
	expect(foreign.unconfirmed).toHaveLength(1);
	await context.db.batch(catalogRetentionWrites(context.db, "a", now));
	expect(await readCatalogChanges(context.db, "a", { since: [afterCohort] })).toEqual(result);
});

it("fix1 unconfirmed retention preserves the exact ninety-day inclusive boundary and required empty array", async () => {
	const context = await fixture();
	await history(context);
	for (const table of ["catalog_changes", "catalog_unconfirmed"] as const)
		await events(context, table, [
			{ id: "expired", at: expired },
			{ id: "boundary", at: cutoff },
		]);
	await context.db.batch(catalogRetentionWrites(context.db, "a", now));
	const result = await readCatalogChanges(context.db, "a", { since: [cutoff] });
	expect(result.added.map((event) => event.event_id)).toEqual(["boundary"]);
	expect(result.unconfirmed.map((event) => event.event_id)).toEqual(["boundary"]);
	await expect(readCatalogChanges(context.db, "a", { since: [expired] })).rejects.toMatchObject({
		status: 410,
	});
	expect(await readCatalogChanges(context.db, "a", { since: [now] })).toMatchObject({
		added: [],
		unconfirmed: [],
	});
});

async function restoration() {
	const context = await fixture(true);
	const replacement = { ...missing };
	const first = await context.plan(forbidden, [replacement, proof], {
		"nocoo/old": "R_NEW",
		"nocoo/private-proof": "R_PROOF",
	});
	await context.publish(first.result);
	const restored = await context.plan(
		forbidden,
		[{ ...missing, visibility: "PRIVATE", is_private: true }, proof],
		{ "nocoo/old": "R_OLD", "nocoo/private-proof": "R_PROOF" },
		later,
	);
	expect(restored.result.restored).toHaveLength(1);
	expect(restored.result.unconfirmed).toHaveLength(1);
	return { context, plan: restored.result };
}

it("fix1 stale revision rolls back catalog ownership, quarantine, unconfirmed, mutable state and heads", async () => {
	const { context, plan } = await restoration();
	await context.raw
		.prepare("UPDATE catalog_state SET revision=revision+1 WHERE account_id='a'")
		.run();
	const original = await state(context);
	await expect(context.db.batch(catalogPlanWrites(context.db, "a", plan))).rejects.toThrow();
	expect(await state(context)).toEqual(original);
});

it("fix1 a mid-restore constraint rolls back both new tables and earlier mutable restoration", async () => {
	const { context, plan } = await restoration();
	await context.raw
		.prepare(
			"CREATE TRIGGER reject_restore BEFORE INSERT ON repo_statistics BEGIN SELECT RAISE(ABORT,'injected restore failure'); END",
		)
		.run();
	const original = await state(context);
	await expect(context.db.batch(catalogPlanWrites(context.db, "a", plan))).rejects.toMatchObject({
		code: "db_error",
	});
	expect(await state(context)).toEqual(original);
	await context.raw.prepare("DROP TRIGGER reject_restore").run();
	await context.db.batch(catalogPlanWrites(context.db, "a", plan));
	expect(await context.saved()).toEqual(context.original);
	expect(
		(await context.raw.prepare("SELECT * FROM catalog_displaced_state").all()).results,
	).toEqual([]);
});

it("fix1 revoked factory lease preserves pending restoration and all catalog publication tables", async () => {
	const { context, plan } = await restoration();
	await startRun(
		context.db,
		makeRun("safety-run", "a", "nocoo", "safety-key", "catalog", [], later),
	);
	const lease = await claimRun(context.db, "safety-run", later);
	if (!lease) throw new Error("Missing safety lease");
	plan.source = { kind: "factory", runId: lease.run.id };
	lease.run.checkpoint = newFactory("a", "nocoo", later);
	lease.run.checkpoint.inventory.complete = true;
	lease.run.checkpoint.repos = plan.rows
		.filter((row) => row.name_current && !row.removed_at)
		.map((row) =>
			mapFactoryRepo({ ...rawRepo, id: row.github_id ?? "unknown", nameWithOwner: row.repo }),
		);
	for (const step of lease.run.steps) if (step.kind !== "publish") step.status = "success";
	await context.raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,'','catalog-plan',?)",
		)
		.bind(lease.run.id, JSON.stringify(plan))
		.run();
	const writes = await publicationWrites(context.db, lease, later);
	await context.raw
		.prepare("UPDATE factory_runs SET lease_token='revoked' WHERE id=?")
		.bind(lease.run.id)
		.run();
	const original = await state(context);
	expect(await saveRun(context.db, lease, writes, later)).toBe(false);
	expect(await state(context)).toEqual(original);
});
