import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ActivitySnapshot } from "../../apps/web/src/lib/activity-types";
import { makeRun } from "../../apps/web/src/lib/factory-run";
import { activityFixture, activityPr, activityRun } from "../e2e/activity-fixtures";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const owner = `activity-${account}`;
const repository = `${owner}/hello-world`;
const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
const wrongScope = `giraffe_${randomBytes(32).toString("base64url")}`;
const expired = `giraffe_${randomBytes(32).toString("base64url")}`;
const snapshot = activityFixture();
const currentId = `activity-${account}`;
const previousId = `previous-${account}`;
const pendingId = `pending-${account}`;
let seeded = false;

const derivedSnapshot = () => ({
	...snapshot,
	totals: { ...snapshot.totals, red_default_branch: null },
	totals_partial: true,
	totals_coverage: {
		missing: [{ repo: repository, metrics: ["red_default_branch"], reason: "missing_evidence" }],
	},
});

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function rows(command: string): Record<string, unknown>[] {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		base !== "http://127.0.0.1:17045" ||
		!persist ||
		!config ||
		resolve(persist) !== resolve(".wrangler/e2e") ||
		resolve(config) !== resolve(".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 runner context required");
	const result = execFileSync(
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
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(result) => result.results,
	);
}
const marker = () =>
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
const request = (
	query = "",
	token: string | null = bearer,
	tag?: string,
	method = "GET",
	selectedAccount = account,
) =>
	fetch(`${base}/api/v1/accounts/${selectedAccount}/activity${query}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(tag ? { "If-None-Match": tag } : {}),
		},
	});

beforeAll(() => {
	marker();
	snapshot.account_id = account;
	snapshot.runId = currentId;
	snapshot.previousRunId = previousId;
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("activity fixture missing");
	repo.repo = repository;
	const workflow = {
		...activityRun(),
		html_url: `https://github.com/${repository}/actions/runs/101`,
		actor: owner,
	};
	repo.ci_runs = [workflow];
	repo.prs.merged = [
		{
			...activityPr(),
			url: `https://github.com/${repository}/pull/81`,
			author: owner,
			merged_by: owner,
		},
	];
	repo.releases = [
		{
			id: "release-1",
			title: "v1.0.0",
			url: `https://github.com/${repository}/releases/tag/v1.0.0`,
			at: snapshot.window.until,
			createdAt: snapshot.window.until,
			closedAt: null,
			mergedAt: null,
			author: owner,
			state: "published",
		},
	];
	snapshot.totals = {
		...snapshot.totals,
		ci_runs: 1,
		merged_prs: 1,
		other_prs: 1,
		releases: 1,
		red_default_branch: [{ ...workflow, repo: repo.repo }],
	};
	const now = new Date().toISOString();
	const mint = (token: string, scopes: string[], suffix: string, expiresAt: string) =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(`${account}-${suffix}`)},${quote(account)},${quote(createHash("sha256").update(token).digest("hex"))},'activity L2',${quote(JSON.stringify(scopes))},'local test',${quote(suffix === "expired" ? "2024-12-31T00:00:00.000Z" : now)},${quote(expiresAt)});`;
	const runRow = (id: string, at: string, status: "running" | "completed") => {
		const run = makeRun(
			id,
			account,
			owner,
			id,
			"refresh",
			[],
			at,
			[],
			[],
			{ scope: "all" },
			"quick",
		);
		run.status = status;
		run.finishedAt = status === "completed" ? at : null;
		return `INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(${quote(id)},${quote(account)},${quote(id)},${quote(status)},${quote(JSON.stringify(run))},${quote(at)},${quote(at)},${quote(at)});`;
	};
	const publication = (data: ActivitySnapshot) =>
		`INSERT INTO activity_publications(account_id,run_id,previous_run_id,until_at,fetched_at,payload,content_version) VALUES(${quote(account)},${quote(data.runId)},${data.previousRunId ? quote(data.previousRunId) : "NULL"},${quote(data.window.until)},${quote(data.fetchedAt)},${quote(JSON.stringify({ ...data, repos: [] }))},${quote(`sha256:${createHash("sha256").update(JSON.stringify(data)).digest("hex")}`)}); INSERT INTO activity_pages(account_id,run_id,page,payload) VALUES(${quote(account)},${quote(data.runId)},0,${quote(JSON.stringify(data.repos))});`;
	const previous = {
		...structuredClone(snapshot),
		runId: previousId,
		previousRunId: null,
		fetchedAt: snapshot.window.since,
		window: {
			...snapshot.window,
			since: "2026-10-20T21:00:00.000Z",
			until: snapshot.window.since,
			first: true,
			gap: true,
		},
	};
	seeded = true;
	rows(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(owner)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
			mint(bearer, ["observations:read"], "reader", new Date(Date.now() + 86400_000).toISOString()),
			mint(wrongScope, ["agent:read"], "agent", new Date(Date.now() + 86400_000).toISOString()),
			mint(expired, ["observations:read"], "expired", "2025-01-01T00:00:00.000Z"),
			`INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(${quote(account)},'repos',${quote(JSON.stringify({ repos: [{ name_with_owner: repo.repo, owner_login: owner }], fetched_at: snapshot.fetchedAt, truncated: false }))},${quote(snapshot.fetchedAt)});`,
			runRow(previousId, previous.window.until, "completed"),
			runRow(currentId, snapshot.window.until, "completed"),
			runRow(pendingId, "2026-10-24T21:00:00.000Z", "running"),
			publication(previous),
			publication(snapshot),
		].join("\n"),
	);
});

afterAll(() => {
	if (!seeded) return;
	marker();
	rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
});

it("R4 HTTP derives frozen counts, excludes unproven branch totals and preserves read-only polling", async () => {
	const saved = () =>
		rows(
			`SELECT * FROM activity_publications WHERE account_id=${quote(account)} ORDER BY run_id; SELECT * FROM activity_pages WHERE account_id=${quote(account)} ORDER BY run_id,page; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id; SELECT * FROM factory_runs WHERE account_id=${quote(account)} ORDER BY id;`,
		);
	const before = saved();
	const calls = await (await fetch("http://127.0.0.1:17046/_count")).text();
	const response = await request();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(derivedSnapshot());
	const prior = await request(`?run=${previousId}`);
	expect(prior.status).toBe(200);
	expect(((await prior.json()) as ActivitySnapshot).window.until).toBe(snapshot.window.since);
	const scoped = await request(`?repository=${encodeURIComponent(repository)}`);
	expect(scoped.status).toBe(200);
	expect(((await scoped.json()) as ActivitySnapshot).repos).toEqual(snapshot.repos);
	const tag = response.headers.get("etag");
	expect(tag).toMatch(/^"[a-f0-9]{40}"$/);
	const conditional = await request("", bearer, `W/${tag}`);
	expect(conditional.status).toBe(304);
	expect(await conditional.text()).toBe("");
	for (const [name, value] of [
		["cache-control", "private, no-store"],
		["vary", "Authorization"],
		["referrer-policy", "no-referrer"],
	])
		expect(conditional.headers.get(String(name))).toBe(value);
	const sources = await fetch(`${base}/api/v1/accounts/${account}/sources`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	expect(sources.status).toBe(200);
	expect(((await sources.json()) as { sources: unknown[] }).sources).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				resource: "account:activity",
				fetchedAt: snapshot.fetchedAt,
				contentVersion: expect.any(String),
			}),
		]),
	);
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(calls);
	expect(saved()).toEqual(before);
});

it("R4 HTTP rejects incomplete runs, unknown runs, malformed selectors and unauthorized conditional requests", async () => {
	for (const [query, status] of [
		["?run=unknown", 404],
		[`?run=${pendingId}`, 409],
		[`?repository=${encodeURIComponent(`${owner}/unknown`)}`, 404],
	] as const) {
		const response = await request(query);
		expect(response.status).toBe(status);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("vary")).toBe("Authorization");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	}
	for (const query of [
		"?x=1",
		"?scope=starred",
		"?run=",
		"?repository=bad",
		"?run=latest&run=other",
		`?repository=${encodeURIComponent(repository)}&repository=${encodeURIComponent(`${owner}/other`)}`,
	]) {
		const response = await request(query, bearer, "*");
		expect(response.status, query).toBe(400);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("vary")).toBe("Authorization");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	}
	for (const [token, status] of [
		[null, 401],
		["invalid", 401],
		[expired, 401],
		[wrongScope, 403],
	] as const)
		expect((await request("", token, "*")).status).toBe(status);
	expect((await request("", bearer, "*", "GET", "z".repeat(21))).status).toBe(403);
	expect((await request("", bearer, "*", "POST")).status).toBe(405);
	expect((await request("", bearer, "*", "HEAD")).status).toBe(405);
});

it("R4 browser activity reads the active account publication with private conditional responses", async () => {
	marker();
	const prior = rows("SELECT id FROM accounts WHERE is_active=1")[0]?.id;
	rows(
		`UPDATE accounts SET is_active=0 WHERE is_active=1; UPDATE accounts SET is_active=1 WHERE id=${quote(account)};`,
	);
	const jwt = process.env.GIRAFFE_JWT;
	const browser = (tag?: string, query = "run=latest") =>
		fetch(`${base}/api/activity?${query}`, {
			headers: {
				...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
				...(tag ? { "If-None-Match": tag } : {}),
			},
		});
	try {
		const calls = await (await fetch("http://127.0.0.1:17046/_count")).text();
		const response = await browser();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(derivedSnapshot());
		const tag = response.headers.get("etag");
		expect(tag).toBeTruthy();
		const conditional = await browser(String(tag));
		expect(conditional.status).toBe(304);
		expect(await conditional.text()).toBe("");
		expect(conditional.headers.get("cache-control")).toBe("private, no-store");
		expect(conditional.headers.get("vary")).toContain("Cf-Access-Jwt-Assertion");
		for (const [query, status] of [
			["unknown=1", 400],
			["run=unknown", 404],
			[`run=${pendingId}`, 409],
		] as const) {
			const error = await browser("*", query);
			expect(error.status).toBe(status);
			expect(error.headers.get("cache-control")).toBe("private, no-store");
			expect(error.headers.get("vary")).toBe("Cookie, Cf-Access-Jwt-Assertion");
			expect(error.headers.get("referrer-policy")).toBe("no-referrer");
		}
		expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(calls);
	} finally {
		marker();
		rows(
			`UPDATE accounts SET is_active=0 WHERE id=${quote(account)};${typeof prior === "string" ? `UPDATE accounts SET is_active=1 WHERE id=${quote(prior)};` : ""}`,
		);
	}
});
