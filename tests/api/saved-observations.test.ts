import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CiReport, CiRun } from "../../apps/web/src/lib/ci-health";
import type { SnapshotFreshness } from "../../apps/web/src/lib/snapshot-freshness";
import { factoryFixture } from "../fixtures/factory-snapshot";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = "batch1aaaaaaaaaaaaaaa";
const baseline = "2026-10-18T12:50:00.000Z";
const latest = "2026-10-20T12:02:00.000Z";
const catalogAt = "2026-10-19T00:00:00.000Z";
const removed = "nocoo/rsshub";
const names = ["nocoo/recovered", "nocoo/baseline", "nocoo/missing", "nocoo/broken"];
let bearer = "";
let originalActive: string | null = null;
let seeded = false;

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
function snapshot(kind: string, data: Record<string, unknown>, at = latest) {
	return `INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(${quote(account)},${quote(kind)},${quote(JSON.stringify({ fetched_at: at, truncated: false, ...data }))},${quote(at)});`;
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

async function machine(path: string) {
	const response = await fetch(`${base}/api/v1/accounts/${account}/${path}`, {
		headers: { authorization: `Bearer ${bearer}` },
	});
	expect(response.status).toBe(200);
	return response;
}

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
	publication.account_id = account;
	publication.repos = [names[0] as string, removed].map((name) => ({
		...repo,
		name,
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
			snapshot(`factory:${name}:commits`, {
				runId: publication.runId,
				items: [],
				next: null,
				ranges: [],
				coverage: { ...repo.coverage.commits, status: "complete", fetchedAt: baseline },
			}),
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
	sql(statements.join("\n"));
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
	);
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
		sql(`SELECT kind,payload FROM snapshots WHERE account_id=${quote(account)} ORDER BY kind`),
	).toEqual(before);
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(countBefore);
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
