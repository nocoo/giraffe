import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CiReport, CiRun } from "../../apps/web/src/lib/ci-health";
import type { FactorySnapshot, FactoryWindow } from "../../apps/web/src/lib/factory-types";
import type { SnapshotFreshness } from "../../apps/web/src/lib/snapshot-freshness";
import { savedContentMeta } from "../../apps/web/src/server/lib/content-version";
import { factoryFixture } from "../fixtures/factory-snapshot";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = "batch1aaaaaaaaaaaaaaa";
const baseline = "2026-10-18T12:50:00.000Z";
const latest = "2026-10-20T12:02:00.000Z";
const catalogAt = "2026-10-19T00:00:00.000Z";
const removed = "nocoo/rsshub";
const names = ["nocoo/recovered", "nocoo/baseline", "nocoo/missing", "nocoo/broken"];
const uploadSummary = {
	name: "actions/upload-artifact",
	version: "v4",
	path: ".github/workflows/ci.yml",
	url: "https://github.com/nocoo/recovered/blob/abc/.github/workflows/ci.yml",
};
const legacyWorkflowDependency = {
	id: ".github/workflows/ci.yml:nocoo/base-ci/.github/workflows/test-job.yml",
	title: "nocoo/base-ci/.github/workflows/test-job.yml",
	version: "main",
	path: ".github/workflows/ci.yml",
	url: "https://github.com/nocoo/recovered/blob/abc/.github/workflows/ci.yml",
	at: null,
	createdAt: null,
	author: null,
	closedAt: null,
	mergedAt: null,
	state: "declared",
};
let bearer = "";
let originalActive: string | null = null;
let seeded = false;
type SavedObservation = {
	contentVersion: string | null;
	sourceVersion: string;
	source: { resource: string };
	data: unknown;
};

function sql(command: string) {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		!persist ||
		!config ||
		resolve(persist) !== resolve(".wrangler/e2e") ||
		resolve(config) !== resolve(".wrangler/e2e-run/wrangler.toml") ||
		base !== "http://127.0.0.1:17045"
	)
		throw new Error("local runner context required");
	const raw = execFileSync(
		resolve("node_modules/.bin/wrangler"),
		[
			"d1",
			"execute",
			"giraffe-db",
			"--local",
			`--persist-to=${persist}`,
			`--config=${config}`,
			"--json",
			"--command",
			command,
		],
		{ encoding: "utf8" },
	);
	return JSON.parse(raw) as { results: Record<string, unknown>[] }[];
}

function assertMarker() {
	expect(sql("SELECT value FROM _test_marker WHERE key='env'")[0]?.results).toEqual([
		{ value: "test" },
	]);
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function snapshot(
	kind: string,
	data: Record<string, unknown>,
	at = latest,
	window?: FactoryWindow,
) {
	const payload = { fetched_at: at, truncated: false, ...data };
	const metadata = await savedContentMeta(kind, payload, window);
	return `INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(${quote(account)},${quote(kind)},${quote(JSON.stringify(payload))},${quote(at)},${quote(metadata)});`;
}

function restoreSnapshots(rows: Record<string, unknown>[]) {
	assertMarker();
	sql(
		rows
			.map(
				(row) =>
					`INSERT OR REPLACE INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(${quote(account)},${quote(String(row.kind))},${quote(String(row.payload))},${quote(String(row.fetched_at))},${typeof row.content_meta === "string" ? quote(row.content_meta) : "NULL"});`,
			)
			.join(""),
	);
}

function browser(path: string, method = "GET", body?: unknown) {
	return fetch(`${base}/api/${path}`, {
		method,
		headers: {
			origin: "https://giraffe.dev.hexly.ai",
			"content-type": "application/json",
			...(process.env.GIRAFFE_JWT ? { "Cf-Access-Jwt-Assertion": process.env.GIRAFFE_JWT } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function machine(path: string, status = 200) {
	const response = await fetch(`${base}/api/v1/accounts/${account}/${path}`, {
		headers: { authorization: `Bearer ${bearer}` },
	});
	expect(response.status).toBe(status);
	return response;
}

it("exposes matching content versions on saved account and repository observations", async () => {
	const index = (await (await machine("sources")).json()) as {
		sources: { resource: string; contentVersion: string | null }[];
	};
	for (const resource of ["issues", "prs", "ci", "repos", "factory"]) {
		const observation = (await (await machine(resource)).json()) as SavedObservation;
		expect(observation.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(
			index.sources.find((source) => source.resource === `account:${resource}`)?.contentVersion,
		).toBe(observation.contentVersion);
	}
	for (const path of [
		"repos/nocoo/recovered/prs",
		"factory/repos/nocoo/recovered/commits",
		"factory/repos/nocoo/recovered/dependencies",
	]) {
		const observation = (await (await machine(path)).json()) as SavedObservation;
		expect(observation.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(
			index.sources.find((source) => source.resource === observation.source.resource)
				?.contentVersion,
		).toBe(observation.contentVersion);
	}
});

it("keeps legacy source hashes null without changing full versions or filling metadata on GET", async () => {
	assertMarker();
	const query = `SELECT kind,payload,fetched_at,content_meta FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`;
	const rows = sql(query)[0]?.results;
	if (!rows?.length) throw new Error("saved fixtures missing");
	const paths = [
		"issues",
		"prs",
		"ci",
		"repos",
		"factory",
		"repos/nocoo/recovered/prs",
		"factory/repos/nocoo/recovered/commits",
	];
	const observations = await Promise.all(
		paths.map(async (path) => (await (await machine(path)).json()) as SavedObservation),
	);
	const before = (await (await machine("sources")).json()) as {
		sources: { resource: string; version: string }[];
	};
	for (const observation of observations)
		expect(observation.contentVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
	try {
		assertMarker();
		sql(`UPDATE snapshots SET content_meta=NULL WHERE account_id=${quote(account)};`);
		const legacyRows = sql(query)[0]?.results;
		const index = (await (await machine("sources")).json()) as {
			sources: { resource: string; version: string; contentVersion: string | null }[];
		};
		for (const source of index.sources) {
			expect(source.contentVersion).toBeNull();
			expect(source.version).toBe(
				before.sources.find((saved: { resource: string }) => saved.resource === source.resource)
					?.version,
			);
		}
		for (const [position, path] of paths.entries()) {
			const observation = (await (await machine(path)).json()) as SavedObservation;
			const original = observations[position];
			if (!original) throw new Error("original observation missing");
			expect(observation.contentVersion).toBeNull();
			expect(observation.sourceVersion).toBe(original.sourceVersion);
			expect(observation.data).toEqual(original.data);
		}
		expect(sql(query)[0]?.results).toEqual(legacyRows);
	} finally {
		restoreSnapshots(rows);
	}
	expect(sql(query)[0]?.results).toEqual(rows);
});

function runs(workflow: string, conclusions: string[], branch = "trunk", day = 20): CiRun[] {
	return conclusions.map((conclusion, index) => ({
		id: day * 100 + index,
		name: workflow,
		html_url: "https://github.com/nocoo/recovered/actions/runs/1",
		status: "completed",
		conclusion,
		event: "push",
		head_branch: branch,
		created_at: `2026-10-${String(day - index).padStart(2, "0")}T00:00:00.000Z`,
		updated_at: `2026-10-${String(day - index).padStart(2, "0")}T00:00:00.000Z`,
	}));
}

beforeAll(async () => {
	assertMarker();
	originalActive =
		(sql("SELECT id FROM accounts WHERE is_active=1")[0]?.results[0]?.id as string | undefined) ??
		null;
	const repos = names.map((name) => ({
		name_with_owner: name,
		owner_login: "batch1",
		is_archived: false,
		is_fork: false,
		pushed_at: baseline,
		open_issue_count: 90,
	}));
	const publication = factoryFixture();
	const repo = publication.repos[0];
	if (!repo) throw new Error("factory fixture missing");
	repo.dependencies = [
		{ name: "@scope/root", version: "1", path: "package.json#name", url: "root" },
		{ name: "@scope/child", version: "1", path: "packages/child/package.json#name", url: "child" },
		{
			name: "@scope/child",
			version: "workspace:*",
			path: "package.json#dependencies",
			url: "self",
		},
		{ name: "recovered", version: "^1", path: "package.json#dependencies", url: "external" },
	];
	repo.coverage.dependencies = {
		...repo.coverage.dependencies,
		status: "complete",
		fetchedAt: baseline,
		observed: 4,
	};
	publication.account_id = account;
	publication.repos = [names[0] as string, removed].map((name) => ({
		...repo,
		name,
		dependencies: [
			...repo.dependencies,
			...Array.from({ length: 7 }, () => ({ ...uploadSummary })),
			{ ...uploadSummary, version: "v3" },
			{ ...uploadSummary },
		],
		observation: {
			version: publication.runId,
			window: publication.window,
			refreshedAt: baseline,
			source: "legacy" as const,
		},
	}));
	publication.inventory.excluded = [{ name: removed, reason: "archived" }];
	const statements = [
		"UPDATE accounts SET is_active=0 WHERE is_active=1;",
		`INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(${quote(account)},'batch1','unused-test-envelope','test',1,${quote(latest)},${quote(latest)});`,
		snapshot("repos", { repos, repository_fetched_at: { "NOCOO/RECOVERED": latest } }, catalogAt),
		snapshot("factory", { ...publication }),
	];
	for (const name of [names[0] as string, removed])
		statements.push(
			snapshot(
				`factory:${name}:commits`,
				{
					runId: publication.runId,
					items: [],
					next: null,
					ranges: [],
					coverage: { ...repo.coverage.commits, status: "complete", fetchedAt: baseline },
				},
				latest,
				publication.window,
			),
		);
	statements.push(
		snapshot(
			`factory:${names[0]}:dependencies`,
			{
				runId: publication.runId,
				next: null,
				ranges: [],
				coverage: repo.coverage.dependencies,
				items: [
					...repo.dependencies.map((dependency, index) => ({
						id: String(index),
						title: dependency.name,
						version: dependency.version,
						path: dependency.path,
						url: dependency.url,
						at: "",
						createdAt: "",
						author: "",
						closedAt: null,
						mergedAt: null,
						state: "declared",
					})),
					legacyWorkflowDependency,
					legacyWorkflowDependency,
				],
			},
			latest,
			publication.window,
		),
	);
	for (const [kind, key] of [
		["issues", "issues"],
		["prs", "pull_requests"],
		["alerts", "items"],
		["notifications", "notifications"],
		["insights", "insights"],
	]) {
		if (!kind || !key) throw new Error("list fixture missing");
		statements.push(
			snapshot(
				kind,
				{
					truncated: kind === "alerts" || kind === "issues",
					[key]: [names[0], names[1], removed].map((name_with_owner, number) => ({
						name_with_owner,
						number,
						title: "retained baseline",
						source: "dependabot",
					})),
					repository_fetched_at: {
						"NOCOO/RECOVERED": kind === "prs" ? baseline : latest,
						[removed]: latest,
					},
				},
				baseline,
			),
		);
	}
	for (const name of [...names, removed]) {
		statements.push(
			snapshot(`repo:${name}:details`, { default_branch: "trunk" }),
			snapshot(`repo:${name}:releases`, { releases: [] }),
		);
	}
	statements.push(
		snapshot(
			"repo:NOCOO/RECOVERED:actions",
			{ runs: runs("CI", ["failure", "failure"], "main", 18) },
			baseline,
		),
		snapshot("repo:NOCOO/RECOVERED:details", { default_branch: "main" }, baseline),
		snapshot("repo:NOCOO/RECOVERED:releases", { releases: [] }, baseline),
		snapshot("repo:NOCOO/RECOVERED:prs", {
			pull_requests: [{ number: 40, title: "new per-repository data" }],
		}),
		snapshot(`repo:${removed}:prs`, { pull_requests: [{ number: 69 }] }),
		snapshot(`repo:${removed}:issues`, { issues: [{ number: 70 }] }),
		snapshot("repo:nocoo/recovered:actions", {
			runs: [
				...runs("Performance lab", ["success", ...Array<string>(6).fill("failure")]),
				...runs("CI", ["success", "failure", "failure"]),
				...runs("CI", ["failure", "failure"]).map((run, index) => ({
					...run,
					event: "pull_request",
					created_at: `2026-10-20T${index === 0 ? "09" : "08"}:00:00.000Z`,
				})),
			],
		}),
		snapshot("repo:nocoo/baseline:actions", {
			runs: [
				...runs("L3 Stress Reproduction", ["failure", "failure"], "trunk", 5),
				...runs("CI", ["failure", "failure"], "cursor/deleted"),
				...Array.from({ length: 30 }, (_, i) => ({
					...runs("CI", ["success"], `expired/${i}`)[0],
					created_at: "2026-04-01T00:00:00.000Z",
					updated_at: "2026-04-01T00:00:00.000Z",
				})),
				...["boundary", "outside"].map((branch, i) => ({
					...runs("CI", ["success"], branch)[0],
					created_at: new Date(Date.parse(latest) - 30 * 86400_000 - i).toISOString(),
					updated_at: new Date(Date.parse(latest) - 30 * 86400_000 - i).toISOString(),
				})),
			],
		}),
		snapshot("repo:nocoo/broken:actions", { runs: runs("CI", ["failure", "failure"]) }),
		snapshot("repo:nocoo/missing:actions", { runs: runs("CI", ["success"], "feature/only") }),
		snapshot(`repo:${removed}:actions`, { runs: runs("CI", ["failure", "failure"]) }),
		`INSERT INTO repo_stars(account_id,repo) VALUES(${quote(account)},'NOCOO/RECOVERED'),(${quote(account)},'nocoo/baseline'),(${quote(account)},${quote(removed)});`,
	);
	sql((await Promise.all(statements)).join("\n"));
	seeded = true;
	const response = await browser("tokens", "POST", {
		account_id: account,
		label: "batch1 local regression",
		scopes: ["observations:read"],
		expires_in_days: 1,
	});
	expect(response.status).toBe(201);
	bearer = ((await response.json()) as { token: string }).token;
});

afterAll(() => {
	if (!seeded) return;
	assertMarker();
	sql(
		`DELETE FROM accounts WHERE id=${quote(account)};${originalActive ? `UPDATE accounts SET is_active=1 WHERE id=${quote(originalActive)};` : ""}`,
	);
});

it("excludes removed repositories from saved account observations without deleting history", async () => {
	const countBefore = await (await fetch("http://127.0.0.1:17046/_count")).text();
	const before = sql(
		`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
	).map((statement) => statement.results);
	for (const path of ["repos", "issues", "prs", "ci", "factory", "sources"]) {
		const data = await (await machine(path)).json();
		expect(JSON.stringify(data).toLowerCase()).not.toContain(removed);
	}
	for (const path of [
		"repos",
		"issues",
		"prs",
		"ci",
		"factory",
		"notifications",
		"alerts",
		"insights",
		`agent/accounts/${account}/sources`,
	]) {
		const response = await browser(path);
		expect(response.status).toBe(200);
		expect((await response.text()).toLowerCase()).not.toContain(removed);
	}
	const details = await fetch(`${base}/api/v1/accounts/${account}/repos/nocoo/rsshub/details`, {
		headers: { authorization: `Bearer ${bearer}` },
	});
	expect(details.status).toBe(404);
	const sources = (await (await machine("sources?repository=NOCOO%2FRECOVERED")).json()) as {
		sources: { resource: string; version: string }[];
	};
	expect(sources.sources.some((source) => source.resource === "repo:NOCOO/RECOVERED:prs")).toBe(
		true,
	);
	const page = (await (await machine("repos/nocoo/recovered/prs")).json()) as {
		sourceVersion: string;
		source: { resource: string };
	};
	expect(page.source.resource).toBe("repo:NOCOO/RECOVERED:prs");
	expect(page.sourceVersion).toBe(
		sources.sources.find((source) => source.resource === page.source.resource)?.version,
	);
	const partial = await browser("alerts?scope=starred");
	expect(partial.status).toBe(200);
	expect(await partial.json()).toMatchObject({ truncated: true, freshness: { missing: 0 } });
	const insights = await browser("insights?scope=starred");
	expect(insights.status).toBe(200);
	expect(await insights.json()).toMatchObject({
		truncated: true,
		freshness: { missing: 0 },
		insights: [
			{ name_with_owner: "nocoo/recovered", open_issue_count: 90, health: "watch" },
			{ name_with_owner: "nocoo/baseline", open_issue_count: 90, health: "watch" },
		],
	});
	expect(
		sql(`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`).map(
			(statement) => statement.results,
		),
	).toEqual(before);
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(countBefore);
});

it("includes baseline and missing repositories in all and starred freshness", async () => {
	for (const resource of ["issues", "prs", "repos"]) {
		for (const scope of ["all", "starred"]) {
			const result = (await (await machine(`${resource}?scope=${scope}`)).json()) as {
				fetchedAt: string;
				freshness: SnapshotFreshness;
				data: { pull_requests?: { number: number }[] };
			};
			expect(result.freshness).toEqual({
				oldestAt: resource === "repos" ? catalogAt : baseline,
				latestAt: latest,
				total: scope === "all" ? 4 : 2,
				missing: resource !== "repos" && scope === "all" ? 2 : 0,
			});
			expect(result.fetchedAt).toBe(result.freshness.latestAt);
			if (resource === "prs")
				expect(result.data.pull_requests).toContainEqual(expect.objectContaining({ number: 40 }));
		}
	}
});

it("exposes the saved factory stream window without changing collection state", async () => {
	const before = sql(
		`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
	).map((statement) => statement.results);
	const countBefore = await (await fetch("http://127.0.0.1:17046/_count")).text();
	const result = await (await machine("factory/repos/nocoo/recovered/commits")).json();
	expect(result).toMatchObject({
		data: {
			ranges: [factoryFixture().window],
			observation: { window: factoryFixture().window },
			coverage: { status: "complete" },
		},
	});
	expect(
		sql(`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`).map(
			(statement) => statement.results,
		),
	).toEqual(before);
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(countBefore);
});

it("normalizes saved dependency unknowns and separates root and workspace identities over HTTP", async () => {
	const before = sql(
		`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
	).map((statement) => statement.results);
	const stream = (await (await machine("factory/repos/nocoo/recovered/dependencies")).json()) as {
		data: { items: { id: string }[] };
	};
	expect(stream).toMatchObject({
		sourceVersion: factoryFixture().runId,
		data: {
			items: [
				{ title: "recovered", at: null, createdAt: null, author: null },
				legacyWorkflowDependency,
			],
			manifests: [
				{ name: "@scope/root", path: "package.json" },
				{ name: "@scope/child", path: "packages/child/package.json" },
			],
		},
	});
	const ids = stream.data.items.map((item: { id: string }) => item.id);
	expect(new Set(ids).size).toBe(ids.length);
	const publication = (await (await machine("factory")).json()) as { data: FactorySnapshot };
	expect(publication.data.repos[0]).toMatchObject({
		dependencies: [{ name: "recovered" }, uploadSummary, { ...uploadSummary, version: "v3" }],
		manifests: [{ name: "@scope/root" }, { name: "@scope/child" }],
	});
	const browserStream = await browser("factory/repos/nocoo/recovered/dependencies");
	expect(browserStream.status).toBe(200);
	expect(await browserStream.json()).toMatchObject({
		total: 2,
		items: [
			legacyWorkflowDependency,
			{ title: "recovered", at: null, createdAt: null, author: null },
		],
	});
	expect(
		sql(`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`).map(
			(statement) => statement.results,
		),
	).toEqual(before);
});

it("deduplicates account dependency summaries over HTTP without stream reads or writes", async () => {
	const before = sql(
		`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
	)[0]?.results;
	const countBefore = await (await fetch("http://127.0.0.1:17046/_count")).text();
	for (const scope of ["all", "starred"]) {
		const machineResult = (await (await machine(`factory?scope=${scope}`)).json()) as {
			data: FactorySnapshot;
		};
		const browserResponse = await browser(`factory?scope=${scope}`);
		expect(browserResponse.status).toBe(200);
		const browserResult = (await browserResponse.json()) as FactorySnapshot;
		for (const publication of [machineResult.data, browserResult]) {
			expect(publication.repos).toHaveLength(1);
			for (const repo of publication.repos) {
				const keys = repo.dependencies.map(({ path, name, version, url }) =>
					JSON.stringify([path, name, version, url]),
				);
				expect(new Set(keys).size).toBe(keys.length);
				expect(repo.dependencies).toEqual([
					{ name: "recovered", version: "^1", path: "package.json#dependencies", url: "external" },
					uploadSummary,
					{ ...uploadSummary, version: "v3" },
				]);
				for (const dependency of repo.dependencies) expect(dependency).not.toHaveProperty("id");
			}
		}
	}
	expect(
		sql(`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`)[0]
			?.results,
	).toEqual(before);
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(countBefore);
});

it("serves pre-observation windows and explains missing or replaced legacy streams over HTTP", async () => {
	assertMarker();
	const rows = sql(
		`SELECT kind,payload,fetched_at,content_meta FROM snapshots WHERE account_id=${quote(account)} AND kind IN ('factory','factory:nocoo/recovered:commits') ORDER BY kind`,
	)[0]?.results;
	if (rows?.length !== 2) throw new Error("legacy fixture missing");
	const countBefore = await (await fetch("http://127.0.0.1:17046/_count")).text();
	try {
		sql(
			`UPDATE snapshots SET payload=json_remove(payload,'$.repos[0].observation') WHERE account_id=${quote(account)} AND kind='factory';`,
		);
		const path = "factory/repos/nocoo/recovered/commits";
		expect(await (await machine(path)).json()).toMatchObject({
			sourceVersion: factoryFixture().runId,
			data: { ranges: [factoryFixture().window], items: [], coverage: { status: "complete" } },
		});
		for (const [command, message] of [
			[
				"UPDATE snapshots SET payload=json_set(payload,'$.runId','another-run')",
				"immutable source version mismatch; refresh this repository",
			],
			["DELETE FROM snapshots", "immutable source missing; refresh this repository"],
		]) {
			sql(
				`${command} WHERE account_id=${quote(account)} AND kind='factory:nocoo/recovered:commits';`,
			);
			const before = sql(
				`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
			)[0]?.results;
			expect(await (await machine(path, 409)).json()).toMatchObject({
				error: { code: "snapshot_missing", message },
			});
			expect(
				sql(
					`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
				)[0]?.results,
			).toEqual(before);
		}
		expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(countBefore);
	} finally {
		restoreSnapshots(rows);
	}
});

it("reads the latest timestamped catalog rate and hides an expired newest observation without writes", async () => {
	const countBefore = await (await fetch("http://127.0.0.1:17046/_count")).text();
	assertMarker();
	const observedAt = new Date(Date.now() - 60_000).toISOString();
	const fresh = {
		remaining: 400,
		resetAt: new Date(Date.now() + 3_600_000).toISOString(),
		resource: "graphql",
		observedAt,
	};
	const stale = {
		...fresh,
		remaining: 300,
		resetAt: new Date(Date.now() - 1_000).toISOString(),
		observedAt: new Date(Date.now() - 30_000).toISOString(),
	};
	sql(
		`INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('batch3-rate',${quote(account)},'batch3-rate','running',${quote(JSON.stringify({ mode: "catalog", checkpoint: { rate: fresh } }))},'t','t','2999-01-01');`,
	);
	try {
		const before = sql(`SELECT payload FROM factory_runs WHERE id='batch3-rate'`).map(
			(statement) => statement.results,
		);
		const snapshots = sql(
			`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
		).map((statement) => statement.results);
		expect(await (await machine("factory")).json()).toMatchObject({ data: { rate: fresh } });
		expect(await (await browser("factory")).json()).toMatchObject({ rate: fresh });
		expect(
			sql(`SELECT payload FROM factory_runs WHERE id='batch3-rate'`).map(
				(statement) => statement.results,
			),
		).toEqual(before);
		expect(
			sql(
				`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
			).map((statement) => statement.results),
		).toEqual(snapshots);
		sql(
			`UPDATE snapshots SET payload=json_set(payload,'$.rate',json(${quote(JSON.stringify(fresh))})) WHERE account_id=${quote(account)} AND kind='factory'; UPDATE factory_runs SET payload=json_set(payload,'$.checkpoint.rate',json(${quote(JSON.stringify(stale))})) WHERE id='batch3-rate';`,
		);
		expect(await (await machine("factory")).json()).toMatchObject({ data: { rate: null } });
		expect(await (await browser("factory")).json()).toMatchObject({ rate: null });
		sql(
			`UPDATE factory_runs SET payload=json_set(payload,'$.checkpoint.rate',json(${quote(JSON.stringify({ ...stale, resetAt: fresh.resetAt, observedAt: null }))})) WHERE id='batch3-rate'; UPDATE snapshots SET payload=json_remove(payload,'$.rate.observedAt') WHERE account_id=${quote(account)} AND kind='factory';`,
		);
		expect(await (await machine("factory")).json()).toMatchObject({ data: { rate: null } });
		expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(countBefore);
		const original = snapshots[0]?.find((row) => row.kind === "factory")?.payload;
		if (typeof original !== "string") throw new Error("fixture");
		sql(
			`UPDATE snapshots SET payload=${quote(original)} WHERE account_id=${quote(account)} AND kind='factory';`,
		);
	} finally {
		assertMarker();
		sql("DELETE FROM factory_runs WHERE id='batch3-rate';");
	}
});

it("separates default-branch workflow and repository verdict units over saved HTTP data", async () => {
	const machineReport = (await (await machine("ci")).json()) as { data: CiReport };
	const report = machineReport.data;
	expect(report.repos.find((repo) => repo.repo === "nocoo/recovered")?.verdict).toBe("flaky");
	expect(report.repos.find((repo) => repo.repo === "nocoo/baseline")?.verdict).toBe("idle");
	expect(report.repos.find((repo) => repo.repo === "nocoo/missing")).toMatchObject({
		verdict: "unknown",
		release: { pipeline: "none" },
	});
	expect(report.totals.unknownRepos).toBe(1);
	expect(report.repos.some((repo) => String(repo.verdict) === "none")).toBe(false);
	expect(
		report.streams.find((stream) => stream.workflow === "L3 Stress Reproduction")?.verdict,
	).toBe("idle");
	expect(report.totals).toMatchObject({
		brokenWorkflows: 1,
		brokenRepos: 1,
		flakyWorkflows: 2,
		flakyRepos: 1,
		idleWorkflows: 1,
		idleRepos: 1,
		nonDefaultBranchFailures: 4,
	});
	expect(report.totals).not.toHaveProperty("broken");
	const response = await browser("ci");
	expect(response.status).toBe(200);
	const browserReport = (await response.json()) as CiReport;
	expect(browserReport.totals).toEqual(report.totals);
});

it("bounds branch streams at the saved 30-day cutoff through machine and browser HTTP", async () => {
	const upstream = await (await fetch("http://127.0.0.1:17046/_count")).text();
	for (const scope of ["all", "starred"]) {
		const report = (await (await machine(`ci?scope=${scope}`)).json()) as { data: CiReport };
		expect(report.data.streams).toHaveLength(scope === "all" ? 8 : 6);
		expect(report.data.totals.nonDefaultBranchStreams).toBe(scope === "all" ? 4 : 3);
		expect(report.data.streams.some((stream) => stream.branch === "boundary")).toBe(true);
		expect(report.data.streams.some((stream) => stream.branch === "outside")).toBe(false);
		expect(report.data.streams.some((stream) => stream.branch?.startsWith("expired/"))).toBe(false);
		expect(
			report.data.streams.find((stream) => stream.workflow === "L3 Stress Reproduction"),
		).toMatchObject({
			scope: "main",
			verdict: "idle",
		});
		expect(new TextEncoder().encode(JSON.stringify(report.data)).length).toBeLessThan(15_000);
		const response = await browser(`ci?scope=${scope}`);
		expect(response.status).toBe(200);
		expect(((await response.json()) as CiReport).streams).toEqual(report.data.streams);
	}
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(upstream);
});

it("keeps latest-any source versions distinct from latest-complete multipage inbox evidence", async () => {
	assertMarker();
	const kinds = [
		"repo:NOCOO/BASELINE:issues",
		"repo:NOCOO/BASELINE:issues#2",
		"repo:nocoo/baseline:issues",
	];
	const before = sql(
		`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
	).map((statement) => statement.results);
	const cleanup = `DELETE FROM snapshots WHERE account_id=${quote(account)} AND kind IN (${kinds.map(quote).join(",")});`;
	try {
		const metadata = await savedContentMeta(kinds[0] as string, {
			fetched_at: catalogAt,
			truncated: false,
			issues: [{ number: 201 }, { number: 202 }],
		});
		sql(
			[
				...(await Promise.all([
					snapshot(kinds[0] as string, { issues: [{ number: 201 }] }, catalogAt),
					snapshot(kinds[1] as string, { issues: [{ number: 202 }] }, catalogAt),
					snapshot(kinds[2] as string, { issues: [{ number: 203 }], unavailable: true }),
				])),
				`UPDATE snapshots SET content_meta=${quote(metadata)} WHERE account_id=${quote(account)} AND kind IN (${quote(kinds[0] as string)},${quote(kinds[1] as string)});`,
			].join("\n"),
		);
		const index = (await (await machine("sources?repository=NOCOO%2FBASELINE")).json()) as {
			repositories: string[];
			sources: { resource: string; version: string; unavailable: boolean }[];
		};
		const page = (await (await machine("repos/nocoo/baseline/issues")).json()) as {
			sourceVersion: string;
			data: { issues: { number: number }[] };
		};
		const inbox = (await (await machine("issues")).json()) as {
			sourceVersion: string;
			data: { issues: { number: number; name_with_owner: string }[] };
		};
		expect(index.repositories).toEqual([...names].sort());
		expect(
			index.sources.find((source) => source.resource === "repo:nocoo/baseline:issues"),
		).toMatchObject({ version: page.sourceVersion, unavailable: true });
		expect(page.data.issues).toEqual([{ number: 203 }]);
		expect(inbox.data.issues.filter((item) => item.name_with_owner === "nocoo/baseline")).toEqual([
			{ number: 201, name_with_owner: "nocoo/baseline" },
			{ number: 202, name_with_owner: "nocoo/baseline" },
		]);
		expect(index.sources.find((source) => source.resource === "account:issues")?.version).toBe(
			inbox.sourceVersion,
		);
		for (const resource of ["repos", "ci", "factory", "prs"])
			expect(index.sources.some((source) => source.resource === `account:${resource}`)).toBe(true);
	} finally {
		assertMarker();
		sql(cleanup);
	}
	expect(
		sql(`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`).map(
			(statement) => statement.results,
		),
	).toEqual(before);
});

function conditionalSources(tag: string, path = "sources", token: string | null = bearer) {
	return fetch(`${base}/api/v1/accounts/${account}/${path}`, {
		headers: { "If-None-Match": tag, ...(token ? { authorization: `Bearer ${token}` } : {}) },
	});
}

it("revalidates private sources over HTTP with response-derived tags and no GET writes", async () => {
	const before = sql(
		`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`,
	).map((statement) => statement.results);
	const tokens = sql(`SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id`).map(
		(statement) => statement.results,
	);

	const full = await machine("sources");
	expect(full.headers.get("server-timing")).toMatch(/d1_1;dur=\d+\.\d{2}/);
	expect(full.headers.get("server-timing")).toMatch(/total;dur=\d+\.\d{2}/);
	const tag = full.headers.get("etag");
	expect(tag).toEqual(expect.stringMatching(/^"[a-f0-9]{64}"$/));
	if (!tag) throw new Error("missing source validator");
	for (const match of [tag, `W/${tag}`, `"other", W/${tag}`, "*"]) {
		const response = await conditionalSources(match);
		expect(response.status).toBe(304);
		expect(response.headers.get("server-timing")).toMatch(/auth;dur=\d+\.\d{2}/);
		expect(await response.text()).toBe("");
		expect(response.headers.get("etag")).toBe(tag);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("vary")).toBe("Authorization");
	}
	expect((await conditionalSources('"unmatched"')).status).toBe(200);
	const selected = await conditionalSources(tag, "sources?repository=NOCOO%2FRECOVERED");
	expect(selected.status).toBe(200);
	expect(selected.headers.get("etag")).not.toBe(tag);
	const since = await conditionalSources(tag, "sources?since=2099-01-01T00%3A00%3A00Z");
	expect(since.status).toBe(200);
	expect(since.headers.get("etag")).not.toBe(tag);
	const original = sql(
		`SELECT payload FROM snapshots WHERE account_id=${quote(account)} AND kind='factory'`,
	)[0]?.results[0]?.payload;
	if (typeof original !== "string") throw new Error("saved publication missing");
	try {
		assertMarker();
		sql(
			`UPDATE snapshots SET payload=json_set(payload,'$.repos[0].coverage.commits.observed',9999) WHERE account_id=${quote(account)} AND kind='factory';`,
		);
		const metadataChanged = await conditionalSources(tag);
		expect(metadataChanged.status).toBe(200);
		expect(metadataChanged.headers.get("etag")).not.toBe(tag);
	} finally {
		assertMarker();
		sql(
			`UPDATE snapshots SET payload=${quote(original)} WHERE account_id=${quote(account)} AND kind='factory';`,
		);
	}
	expect(
		sql(`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`).map(
			(statement) => statement.results,
		),
	).toEqual(before);
	expect(
		sql(`SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id`).map(
			(statement) => statement.results,
		),
	).toEqual(tokens);
});

it("checks authentication, account, scopes and filters before conditional success over HTTP", async () => {
	const tag = (await machine("sources")).headers.get("etag") ?? '"missing"';
	const mint = async (scopes: string[]) => {
		const response = await browser("tokens", "POST", {
			account_id: account,
			label: "conditional local auth",
			scopes,
			expires_in_days: 1,
		});
		expect(response.status).toBe(201);
		return (await response.json()) as { id: string; token: string };
	};
	const expired = await mint(["observations:read"]);
	const revoked = await mint(["observations:read"]);
	const wrongScope = await mint(["agent:read"]);
	assertMarker();
	sql(
		`UPDATE api_tokens SET created_at='2024-12-31T00:00:00Z',expires_at='2025-01-01T00:00:00Z' WHERE id=${quote(expired.id)};UPDATE api_tokens SET revoked_at='2025-01-01T00:00:00Z' WHERE id=${quote(revoked.id)};`,
	);
	const before = sql(`SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id`).map(
		(statement) => statement.results,
	);
	for (const [token, status] of [
		[null, 401],
		["invalid", 401],
		[expired.token, 401],
		[revoked.token, 401],
		[wrongScope.token, 403],
	] as const)
		for (const match of [tag, "*"]) {
			const response = await conditionalSources(match, "sources", token);
			expect(response.status).toBe(status);
			expect(response.headers.has("etag")).toBe(false);
		}
	for (const query of ["?x=1", "?since=invalid", "?repository=invalid"])
		expect((await conditionalSources("*", `sources${query}`)).status).toBe(400);
	expect((await conditionalSources("*", "sources?repository=outside%2Fcatalog")).status).toBe(404);
	const other = await fetch(`${base}/api/v1/accounts/other/sources`, {
		headers: { authorization: `Bearer ${bearer}`, "If-None-Match": "*" },
	});
	expect(other.status).toBe(403);
	expect(other.headers.has("etag")).toBe(false);
	expect(
		sql(`SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id`).map(
			(statement) => statement.results,
		),
	).toEqual(before);
});
