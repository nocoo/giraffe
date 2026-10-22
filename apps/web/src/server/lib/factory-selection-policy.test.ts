import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { FactoryRun } from "../../lib/factory-run";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { REPO_SNAPSHOT_TABS } from "../../lib/snapshot-kinds";
import { createDb } from "./db/d1";
import { readSnapshot, replaceSnapshotStmts } from "./db/snapshots";
import { exclusion } from "./factory-map";
import { saveSchedule, scheduleRefreshes } from "./refresh-schedule";
import { projectFactory, repoPolicy } from "./snapshot-projection";

const now = "2026-10-18T00:00:00.000Z";
const legacyNames = [
	"arena",
	"codo",
	"deca",
	"dogfight",
	"dreamro",
	"flow",
	"nocoo",
	"pi-agent-policy",
	"pika",
	"rooster",
	"runner",
	"shrike",
	"snaky",
].map((name) => `nocoo/${name}`);
const legacyStars = ["nocoo/pi-agent-policy", "nocoo/snaky"];

async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snapshot = factoryFixture();
	const first = snapshot.repos[0];
	if (!first) throw new Error("missing fixture repository");
	snapshot.fetched_at = now;
	snapshot.repos.push(
		...legacyNames.map((name, index) => ({ ...first, name, id: `R_disabled_${index}` })),
	);
	snapshot.inventory.total = snapshot.repos.length;
	snapshot.inventory.scanned = snapshot.repos.length;
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(snapshot.account_id, snapshot.owner, "fake", "fake", now, now)
		.run();
	await db.batch(await replaceSnapshotStmts(db, snapshot.account_id, "factory", snapshot, now));
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snapshot.account_id,
			"repos",
			{
				truncated: false,
				repos: snapshot.repos.map((repo) => ({
					name_with_owner: repo.name,
					owner_login: snapshot.owner,
					is_archived: false,
					is_fork: false,
				})),
			},
			now,
		),
	);
	await db.batch([
		...legacyNames.map((name) =>
			db
				.prepare("INSERT INTO repo_statistics(account_id,repo,enabled) VALUES(?,?,0)")
				.bind(snapshot.account_id, name),
		),
		...[first.name, ...legacyStars].map((name) =>
			db
				.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,?)")
				.bind(snapshot.account_id, name),
		),
	]);
	return { raw, db, snapshot, first };
}

it("includes former statistics exclusions in the weekly owned set without changing saved data", async () => {
	const { db, snapshot, first } = await setup();
	const before = await readSnapshot(db, snapshot.account_id, "factory");
	const policy = await repoPolicy(db, snapshot.account_id);
	const projected = projectFactory(snapshot, policy);
	expect(projected.repos.map((repo) => repo.name)).toEqual([first.name, ...legacyNames]);
	expect(projected.inventory.excluded).toEqual([]);
	for (const name of legacyNames) {
		expect(policy.includes(name)).toBe(true);
		expect(policy.includes(name)).toBe(true);
	}
	expect(await readSnapshot(db, snapshot.account_id, "factory")).toEqual(before);
	expect(snapshot.repos).toHaveLength(14);
});

it.each([
	["weekly", "all"],
	["weekly", "starred"],
	["daily", "starred"],
] as const)(
	"uses the same owned membership for factory streams and detail pages for %s/%s",
	async (kind, scope) => {
		const { raw, db, snapshot, first } = await setup();
		await saveSchedule(
			db,
			snapshot.account_id,
			kind,
			{ enabled: true, time: "08:00", weekday: 0, scope },
			"2026-10-17T00:01:00.000Z",
		);
		await scheduleRefreshes(raw, now);
		const rows = await db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>();
		expect(rows.results).toHaveLength(1);
		const run = JSON.parse(rows.results[0]?.payload ?? "{}") as FactoryRun;
		const pageNames = scope === "all" ? legacyNames : legacyStars;
		const selected = [first.name, ...pageNames];
		expect(run).toMatchObject({
			mode: "refresh",
			trigger: kind,
			repos: selected,
			selection: { scope: scope === "all" ? "all" : "selected", order: selected },
		});
		expect(run.siteRepos).toEqual([first.name, ...pageNames]);
		if (scope === "starred") expect(run.selection?.repos).toEqual([first.name, ...legacyStars]);
		expect(
			run.steps.filter((step) => step.repo === first.name && step.kind !== "snapshot"),
		).toEqual(
			["metadata", ...FACTORY_STREAMS, "commit", ...(kind === "daily" ? ["activity"] : [])].map(
				(stepKind) => expect.objectContaining({ kind: stepKind, status: "pending" }),
			),
		);
		for (const name of legacyNames) {
			const steps = run.steps.filter((step) => step.repo === name);
			expect(steps.filter((step) => step.kind !== "snapshot").map((step) => step.kind)).toEqual(
				pageNames.includes(name)
					? ["metadata", ...FACTORY_STREAMS, "commit", ...(kind === "daily" ? ["activity"] : [])]
					: [],
			);
			expect(steps.filter((step) => step.kind === "snapshot").map((step) => step.resource)).toEqual(
				pageNames.includes(name) ? REPO_SNAPSHOT_TABS.map((tab) => `repo:${name}:${tab}`) : [],
			);
			expect(steps.every((step) => step.status === "pending")).toBe(true);
		}
		expect(
			run.steps.filter((step) => step.kind === "contributions" || step.resource === "insights"),
		).toHaveLength(kind === "daily" || scope === "all" ? 2 : 0);
	},
);

it("includes owned archives and forks regardless of obsolete statistics overrides", async () => {
	const { db, snapshot } = await setup();
	const names = legacyNames.slice(0, 3);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snapshot.account_id,
			"repos",
			{
				repos: names.map((name_with_owner) => ({
					name_with_owner,
					is_archived: true,
					is_fork: true,
				})),
			},
			now,
		),
	);
	await db
		.prepare("DELETE FROM repo_statistics WHERE account_id=? AND repo=?")
		.bind(snapshot.account_id, names[0])
		.run();
	await db
		.prepare("UPDATE repo_statistics SET enabled=1 WHERE account_id=? AND repo=?")
		.bind(snapshot.account_id, names[1])
		.run();
	const policy = await repoPolicy(db, snapshot.account_id);
	expect(names.map((name) => policy.includes(name))).toEqual([true, true, true]);
	expect(projectFactory(snapshot, policy).repos.map((repo) => repo.name)).toEqual(names);
	expect(exclusion({ owner: { login: "other" }, nameWithOwner: "other/repo" }, "nocoo")).toBe(
		"not-owner",
	);
	expect(
		exclusion({ owner: { login: "nocoo" }, nameWithOwner: "nocoo/mirror" }, "nocoo"),
	).toBeNull();
});

it.each(["daily", "weekly"] as const)(
	"rediscovers legacy omitted owned members before %s refresh",
	async (kind) => {
		const { raw, db, snapshot } = await setup();
		const archive = "nocoo/legacy-archive";
		await db.batch(
			await replaceSnapshotStmts(
				db,
				snapshot.account_id,
				"repos",
				{
					repos: [
						...snapshot.repos.map((repo) => ({ name_with_owner: repo.name })),
						{ name_with_owner: archive, is_archived: true },
					],
				},
				now,
			),
		);
		await db
			.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,?)")
			.bind(snapshot.account_id, archive)
			.run();
		await saveSchedule(
			db,
			snapshot.account_id,
			kind,
			{ enabled: true, time: "08:00", weekday: 0, scope: kind === "daily" ? "starred" : "all" },
			"2026-10-17T00:01:00.000Z",
		);
		await scheduleRefreshes(raw, now);
		const runs = await db.prepare("SELECT payload FROM factory_runs").all<{ payload: string }>();
		expect(runs.results.map((row) => JSON.parse(row.payload))).toEqual([
			expect.objectContaining({ mode: "catalog", trigger: kind, status: "running" }),
		]);
	},
);
