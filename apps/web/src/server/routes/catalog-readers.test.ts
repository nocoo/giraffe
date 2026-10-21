import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { createDb } from "../lib/db/d1";
import { replaceSnapshotStmts } from "../lib/db/snapshots";
import { readObservation } from "../lib/machine-observations";

it("shares saved CI evidence between browser and machine and never assumes a default branch", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','owner','fake','fake',1,'t','t')",
		)
		.run();
	const at = "2026-10-20T00:00:00Z";
	const save = async (kind: string, value: Record<string, unknown>) =>
		db.batch(await replaceSnapshotStmts(db, "a", kind, value, at));
	await save("repos", {
		repos: ["owner/app", "owner/unknown", "owner/empty-branch", "owner/unsaved"].map(
			(name_with_owner) => ({ name_with_owner }),
		),
	});
	for (const name of ["OWNER/APP", "owner/unknown", "owner/empty-branch", "owner/removed"]) {
		await save(`repo:${name}:actions`, {
			runs: [
				{
					id: 1,
					name: "CI",
					status: "completed",
					conclusion: "failure",
					head_branch: "main",
					created_at: at,
					updated_at: at,
					event: "push",
				},
			],
		});
		await save(`repo:${name}:releases`, { releases: [] });
	}
	await save("repo:OWNER/APP:details", { default_branch: "main" });
	await save("repo:owner/empty-branch:details", { default_branch: "" });
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	const response = await createApp().request("http://localhost/api/ci?scope=all", {}, {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env);
	expect(response.status).toBe(200);
	const browser = (await response.json()) as Record<string, unknown>;
	const machine = await readObservation(createDb(raw), "a", "ci", "all");
	expect(machine.data).toEqual({ ...browser, account_id: undefined });
	expect(browser).toMatchObject({
		freshness: { total: 12, missing: 4 },
		unsaved: ["owner/unsaved"],
		totals: {
			totalRepos: 3,
			totalWorkflows: 1,
			flakyWorkflows: 1,
			nonDefaultBranchStreams: 2,
			nonDefaultBranchFailures: 2,
		},
	});
	expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
});

it("counts catalog repositories without factory publications and preserves published source windows", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snap = factoryFixture();
	const account = snap.account_id;
	const first = snap.repos[0];
	if (!first) throw new Error("fixture");
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'nocoo','fake','fake',1,'t','t')",
		)
		.bind(account)
		.run();
	const save = async (kind: string, value: Record<string, unknown>) =>
		db.batch(await replaceSnapshotStmts(db, account, kind, value, snap.fetched_at));
	await save("repos", {
		repos: ["nocoo/app", "nocoo/missing", "nocoo/no-observation"].map((name_with_owner) => ({
			name_with_owner,
		})),
	});
	first.observation = {
		source: "legacy",
		version: "original",
		window: snap.window,
		refreshedAt: "2026-09-01T00:00:00Z",
	};
	const unobserved = { ...first, name: "nocoo/no-observation" };
	delete unobserved.observation;
	snap.repos.push({ ...first, name: "nocoo/removed" }, unobserved);
	snap.inventory.excluded.push({ name: "nocoo/removed", reason: "fork" });
	await save("factory", snap);
	for (const repo of ["NOCOO/APP", "nocoo/missing", "nocoo/no-observation", "nocoo/removed"])
		await db
			.prepare("INSERT INTO factory_repo_state(account_id,repo,payload) VALUES(?,?,?)")
			.bind(account, repo, JSON.stringify({ repo, status: "success", refreshedAt: null }))
			.run();
	const before = await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all();
	const env = { DB: raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env;
	const app = createApp();
	const browser = (await (
		await app.request("http://localhost/api/factory", {}, env)
	).json()) as Record<string, unknown>;
	expect(browser).toMatchObject({
		repos: [
			{ name: "nocoo/app", observation: { version: "original", window: snap.window } },
			{ name: "nocoo/no-observation" },
		],
		fetched_at: "2026-09-01T00:00:00Z",
		freshness: { total: 3, missing: 2, oldestAt: "2026-09-01T00:00:00Z" },
		inventory: { excluded: [] },
		contribution: null,
		contributionStatus: snap.contributionStatus,
	});
	expect(browser).not.toHaveProperty("contributionExcluded");
	expect((await readObservation(createDb(raw), account, "factory", "all")).data).toEqual({
		...browser,
		account_id: account,
	});
	const runs = await (await app.request("http://localhost/api/factory/runs", {}, env)).json();
	expect(runs).toMatchObject({
		repositories: [
			{ repo: "NOCOO/APP" },
			{ repo: "nocoo/missing" },
			{ repo: "nocoo/no-observation" },
		],
	});
	expect(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).toEqual(before);
});
