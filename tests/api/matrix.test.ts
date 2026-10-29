import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeD1FixtureSync } from "../fixtures/d1";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { savedSnapshotSql } from "./saved-fixture";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const suite = process.env.GIRAFFE_SUITE ?? "A";
const origin = "https://giraffe.dev.hexly.ai";
const jwt = process.env.GIRAFFE_JWT ?? "";
const jwtBadAud = process.env.GIRAFFE_JWT_BAD_AUD ?? "";
const jwtBadSig = process.env.GIRAFFE_JWT_BAD_SIG ?? "";
const PAT = `ghp_${"A".repeat(36)}`;
const PAT_401 = `ghp_${"B".repeat(36)}`;
const PAT_SCOPE = `ghp_${"C".repeat(36)}`;
const PAT_2 = `ghp_${"D".repeat(36)}`;

const GETS = [
	"/api/me",
	"/api/accounts",
	"/api/repos",
	"/api/issues",
	"/api/prs",
	"/api/insights",
	"/api/alerts",
	"/api/notifications",
	"/api/repos/octocat/hello-world",
	"/api/repos/octocat/hello-world/actions",
	"/api/repos/octocat/hello-world/traffic",
	"/api/repos/octocat/hello-world/security",
	"/api/repos/octocat/hello-world/issues",
	"/api/repos/octocat/hello-world/prs",
	"/api/repos/octocat/hello-world/releases",
	"/api/repos/octocat/hello-world/languages",
	"/api/repos/octocat/hello-world/contributors",
	"/api/ci",
];

const FACTORY_GETS = [
	"/api/activity",
	"/api/factory",
	"/api/factory/repos/octocat/hello-world/commits",
];

const WRITES: Array<[string, string, RequestInit]> = [
	["POST", "/api/refresh-runs/missing/cancel", {}],
	["POST", "/api/repos/octocat/hello-world/star", {}],
	[
		"POST",
		"/api/accounts",
		{ headers: { "content-type": "application/json" }, body: JSON.stringify({ token: PAT }) },
	],
	["POST", "/api/accounts/x/activate", {}],
	["DELETE", "/api/accounts/x", {}],
	[
		"POST",
		"/api/notifications/read",
		{
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "123", account_id: "x" }),
		},
	],
	[
		"POST",
		"/api/notifications/read-all",
		{
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ account_id: "x" }),
		},
	],
];

function accessHeaders(extra: HeadersInit = {}, token = jwt): HeadersInit {
	const headers = new Headers(extra);
	if (suite === "B" && token) {
		headers.set("Cf-Access-Jwt-Assertion", token);
	}
	return headers;
}

async function api(path: string, init: RequestInit = {}, token = jwt): Promise<Response> {
	const headers = new Headers(accessHeaders(init.headers, token));
	let last: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await fetch(`${base}${path}`, { ...init, headers });
		} catch (err) {
			last = err;
			const msg = String(err);
			if (!msg.includes("ECONNRESET") && !msg.includes("fetch failed")) {
				throw err;
			}
			await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
		}
	}
	throw last;
}

function rawMethod(method: string, path: string): Promise<number> {
	const url = new URL(`${base}${path}`);
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ hostname: url.hostname, port: url.port, path: url.pathname, method },
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function githubCount(): Promise<number> {
	const res = await fetch("http://127.0.0.1:17046/_count");
	return Number(await res.text());
}

function d1Rows(sql: string): Array<Record<string, unknown>> {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (!persist || !config) {
		return [];
	}
	const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
	const raw = executeD1FixtureSync(sql, { persist, config, root });
	const parsed = JSON.parse(raw) as Array<{ results?: Array<Record<string, unknown>> }>;
	return parsed[0]?.results ?? [];
}

function noSecrets(value: unknown): void {
	const text = JSON.stringify(value);
	expect(text).not.toContain(PAT);
	expect(text).not.toContain(PAT_401);
	expect(text).not.toContain(PAT_SCOPE);
	expect(text).not.toContain(PAT_2);
	expect(text).not.toContain("token_ciphertext");
	expect(text).not.toContain('"iv"');
	expect(text).not.toContain('"ct"');
	expect(text).not.toContain('"tag"');
}

function snapshotMeta(body: Record<string, unknown>): void {
	expect(typeof body.fetched_at).toBe("string");
	expect((body.fetched_at as string).length).toBeGreaterThan(10);
	expect(typeof body.truncated).toBe("boolean");
	expect(typeof body.account_id).toBe("string");
	expect((body.account_id as string).length).toBeGreaterThan(0);
}

describe("api method matrix", () => {
	it("covers suite A/B contracts for every listed path", async () => {
		if (suite === "B") {
			for (const path of [...GETS, ...FACTORY_GETS]) {
				expect((await fetch(`${base}${path}`)).status).toBe(401);
				expect(
					(
						await fetch(`${base}${path}`, {
							headers: { "Cf-Access-Jwt-Assertion": jwtBadSig },
						})
					).status,
				).toBe(401);
				expect(
					(
						await fetch(`${base}${path}`, {
							headers: { "Cf-Access-Jwt-Assertion": jwtBadAud },
						})
					).status,
				).toBe(401);
				expect((await api(path)).status).not.toBe(401);
			}
			for (const [method, path, init] of WRITES) {
				const extra = (init.headers as Record<string, string> | undefined) ?? {};
				expect(
					(
						await fetch(`${base}${path}`, {
							method,
							headers: { origin, ...extra },
							body: init.body,
						})
					).status,
				).toBe(401);
				expect(
					(
						await fetch(`${base}${path}`, {
							method,
							headers: { origin, "Cf-Access-Jwt-Assertion": jwtBadSig, ...extra },
							body: init.body,
						})
					).status,
				).toBe(401);
				expect(
					(
						await fetch(`${base}${path}`, {
							method,
							headers: { origin, "Cf-Access-Jwt-Assertion": jwtBadAud, ...extra },
							body: init.body,
						})
					).status,
				).toBe(401);
				expect(
					(
						await api(path, {
							method,
							headers: { origin, ...extra },
							body: init.body,
						})
					).status,
				).not.toBe(401);
			}
		}

		expect((await api("/api")).status).toBe(404);
		if (suite === "B") {
			expect((await fetch(`${base}/api`)).status).toBe(401);
		}
		if (suite === "A") {
			expect(await rawMethod("TRACE", "/api/me")).toBe(405);
			expect(await rawMethod("MKCOL", "/api/me")).toBe(405);
			expect(await rawMethod("PROPFIND", "/api/accounts")).toBe(405);
		}
		const me = await api("/api/me");
		expect(me.status).toBe(200);
		const meBody = (await me.json()) as { email?: string; name?: string };
		expect(meBody.email).toEqual(expect.any(String));
		noSecrets(meBody);
		expect((await api("/api/accounts")).status).toBe(200);
		if (suite === "A") {
			for (const path of GETS.filter((p) => p !== "/api/me" && p !== "/api/accounts")) {
				const missing = await api(path);
				expect(missing.status).toBe(409);
				expect(await missing.json()).toMatchObject({
					error: { code: "account_missing" },
				});
			}
		}
		if (suite === "A") {
			for (const path of FACTORY_GETS) {
				expect((await api(path)).status).toBe(409);
			}
		}
		const noOrigin = await api("/api/accounts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: PAT }),
		});
		expect(noOrigin.status).toBe(403);
		expect(await noOrigin.json()).toMatchObject({ error: { code: "origin_forbidden" } });
		expect(
			(
				await api("/api/accounts", {
					method: "POST",
					headers: { origin: "https://evil.example", "content-type": "application/json" },
					body: JSON.stringify({ token: PAT }),
				})
			).status,
		).toBe(403);
		for (const [method, path, init] of WRITES) {
			expect(
				(
					await api(path, {
						method,
						headers: { ...(init.headers as HeadersInit) },
						body: init.body,
					})
				).status,
			).toBe(403);
			expect(
				(
					await api(path, {
						method,
						headers: { origin: "https://evil.example", ...(init.headers as HeadersInit) },
						body: init.body,
					})
				).status,
			).toBe(403);
		}
		const created = await api("/api/accounts", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ token: PAT }),
		});
		expect(created.status).toBe(201);
		const account = (await created.json()) as {
			id: string;
			login?: string;
			token_last4?: string;
			is_active?: boolean;
			capabilities?: Record<string, boolean>;
			avatar_url?: string;
			scopes?: string;
		};
		expect(account).toMatchObject({
			id: expect.any(String),
			login: "octocat",
			avatar_url: expect.any(String),
			token_last4: expect.any(String),
			scopes: expect.any(String),
			is_active: true,
		});
		expect(account.capabilities).toEqual({
			repo: true,
			"read:org": true,
			"read:user": true,
			notifications: true,
		});
		noSecrets(account);
		if (suite === "A") {
			for (const path of GETS.filter((p) => p !== "/api/me" && p !== "/api/accounts")) {
				const missingSnap = await api(path);
				expect(missingSnap.status).toBe(409);
				expect(await missingSnap.json()).toMatchObject({
					error: { code: "snapshot_missing" },
				});
			}
		}
		const envelopes = d1Rows("SELECT token_ciphertext FROM accounts");
		expect(envelopes.length).toBeGreaterThan(0);
		const envelope = String(envelopes[0]?.token_ciphertext ?? "");
		expect(envelope).not.toContain(PAT);
		expect(envelope).toContain('"iv"');
		expect(envelope).toContain('"ct"');
		expect(envelope).toContain('"tag"');
		const parsedEnvelope = JSON.parse(envelope) as { iv?: string; ct?: string; tag?: string };
		expect(parsedEnvelope.iv).toEqual(expect.any(String));
		expect(parsedEnvelope.ct).toEqual(expect.any(String));
		expect(parsedEnvelope.tag).toEqual(expect.any(String));
		const liveBody = await (await api("/api/live")).json();
		noSecrets(liveBody);
		const listed = await api("/api/accounts");
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as { accounts: Array<Record<string, unknown>> };
		expect(listedBody.accounts[0]).toMatchObject({
			id: account.id,
			login: "octocat",
			avatar_url: expect.any(String),
			token_last4: expect.any(String),
			scopes: expect.any(String),
			is_active: true,
		});
		expect(listedBody.accounts[0]?.capabilities).toEqual({
			repo: true,
			"read:org": true,
			"read:user": true,
			notifications: true,
		});
		noSecrets(listedBody);
		const logPath = process.env.GIRAFFE_WRANGLER_LOG;
		const badPat = await api("/api/accounts", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ token: "nope" }),
		});
		expect(badPat.status).toBe(400);
		const badPatJson = await badPat.json();
		expect(badPatJson).toMatchObject({ error: { code: "validation_failed" } });
		expect(JSON.stringify(badPatJson)).not.toContain("nope");
		noSecrets(badPatJson);
		const unauthGithub = await api("/api/accounts", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ token: PAT_401 }),
		});
		expect(unauthGithub.status).toBe(401);
		const unauthJson = await unauthGithub.json();
		expect(unauthJson).toMatchObject({ error: { code: "github_unauthorized" } });
		noSecrets(unauthJson);
		const scopeRes = await api("/api/accounts", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ token: PAT_SCOPE }),
		});
		expect(scopeRes.status).toBe(400);
		const scopeJson = await scopeRes.json();
		expect(scopeJson).toMatchObject({ error: { code: "scopes_missing" } });
		noSecrets(scopeJson);
		if (logPath) {
			const log = readFileSync(logPath, "utf8");
			expect(log).not.toContain(PAT);
			expect(log).not.toContain(PAT_401);
			expect(log).not.toContain(PAT_SCOPE);
			expect(log).not.toContain("nope");
		}

		const at = "2026-10-22T00:00:00.000Z";
		const repo = "octocat/hello-world";
		const issue = {
			name_with_owner: repo,
			number: 1,
			title: "saved issue",
			state: "OPEN",
			url: "https://github.com/octocat/hello-world/issues/1",
		};
		const pr = {
			name_with_owner: repo,
			number: 2,
			title: "saved PR",
			state: "open",
			url: "https://github.com/octocat/hello-world/pull/2",
		};
		const snapshots: Record<string, Record<string, unknown>> = {
			repos: {
				repos: [
					{
						name_with_owner: repo,
						name: "hello-world",
						owner_login: "octocat",
						stargazer_count: 1,
						fork_count: 0,
						url: "https://github.com/octocat/hello-world",
					},
				],
			},
			issues: { issues: [issue] },
			prs: { pull_requests: [pr] },
			alerts: {
				unavailable: false,
				dependabot_open: 1,
				code_scanning_open: 0,
				items: [
					{ name_with_owner: repo, source: "dependabot", severity: "low", summary: "saved alert" },
				],
			},
			insights: { insights: [] },
			notifications: {
				notifications: [
					{ id: "123", unread: true, name_with_owner: repo },
					{ id: "456", unread: true, name_with_owner: repo },
				],
			},
			"repo:octocat/hello-world:details": {
				default_branch: "main",
				url: "https://github.com/octocat/hello-world",
			},
			"repo:octocat/hello-world:actions": { runs: [] },
			"repo:octocat/hello-world:traffic": {
				forbidden: false,
				views: { count: 2, uniques: 1 },
				clones: { count: 1, uniques: 1 },
			},
			"repo:octocat/hello-world:security": {
				unavailable: false,
				dependabot_open: 1,
				code_scanning_open: 0,
			},
			"repo:octocat/hello-world:issues": { issues: [issue] },
			"repo:octocat/hello-world:prs": { pull_requests: [pr] },
			"repo:octocat/hello-world:releases": { releases: [] },
			"repo:octocat/hello-world:languages": { languages: { TypeScript: 1 } },
			"repo:octocat/hello-world:contributors": { contributors: [] },
		};
		const publication = factoryFixture();
		publication.account_id = account.id;
		publication.owner = "octocat";
		publication.runId = `saved-${account.id}`;
		publication.status = "complete";
		const factoryRepo = publication.repos[0];
		if (!factoryRepo) throw new Error("factory fixture missing");
		factoryRepo.name = repo;
		factoryRepo.url = "https://github.com/octocat/hello-world";
		snapshots[`factory:v:${publication.runId}`] = { ...publication };
		expect(d1Rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		d1Rows(
			Object.entries(snapshots)
				.map(([kind, value]) =>
					savedSnapshotSql(account.id, kind, { ...value, fetched_at: at, truncated: false }, at),
				)
				.join("\n"),
		);
		expect(await (await api("/api/repos")).json()).toMatchObject({
			repos: [expect.objectContaining({ name_with_owner: repo })],
		});
		expect(await (await api("/api/issues")).json()).toMatchObject({
			issues: [expect.objectContaining({ title: "saved issue" })],
		});
		expect(await (await api("/api/alerts")).json()).toMatchObject({ dependabot_open: 1 });
		expect(await (await api("/api/repos/octocat/hello-world/languages")).json()).toMatchObject({
			languages: { TypeScript: 1 },
		});
		const snapRows = d1Rows("SELECT kind, fetched_at FROM refresh_snapshots ORDER BY kind");
		expect(snapRows.length).toBeGreaterThan(0);
		for (const row of snapRows) {
			expect(String(row.fetched_at).length).toBeGreaterThan(10);
		}
		const accountRows = d1Rows("SELECT login, last_used_at, is_active FROM accounts");
		expect(accountRows[0]).toMatchObject({ login: "octocat", is_active: 1 });
		expect(String(accountRows[0]?.last_used_at ?? "").length).toBeGreaterThan(10);
		const beforeRows = d1Rows(
			"SELECT kind, payload, fetched_at FROM refresh_snapshots ORDER BY kind",
		);
		const beforeAccounts = d1Rows("SELECT login, last_used_at, is_active FROM accounts");
		const before = await githubCount();
		for (const path of GETS.filter((p) => p !== "/api/me" && p !== "/api/accounts")) {
			const res = await api(path);
			expect(res.status).toBe(200);
			const body = await res.json();
			noSecrets(body);
			snapshotMeta(body as Record<string, unknown>);
		}
		expect(await githubCount()).toBe(before);
		expect(d1Rows("SELECT kind, payload, fetched_at FROM refresh_snapshots ORDER BY kind")).toEqual(
			beforeRows,
		);
		expect(d1Rows("SELECT login, last_used_at, is_active FROM accounts")).toEqual(beforeAccounts);
		const readRes = await api("/api/notifications/read", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ id: "123", account_id: account.id }),
		});
		expect(readRes.status).toBe(200);
		const readBody = await readRes.json();
		noSecrets(readBody);
		const afterRead = await api("/api/notifications");
		expect(afterRead.status).toBe(200);
		const notifBody = (await afterRead.json()) as {
			notifications: Array<{ id?: string; unread?: boolean }>;
		};
		expect(notifBody).toEqual(readBody);
		expect(notifBody.notifications[0]).toMatchObject({ id: "123", unread: false });
		expect(notifBody.notifications[1]).toMatchObject({ id: "456", unread: true });
		const readAllRes = await api("/api/notifications/read-all", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ account_id: account.id }),
		});
		expect(readAllRes.status).toBe(200);
		const readAllBody = await readAllRes.json();
		const afterAll = await (await api("/api/notifications")).json();
		expect(afterAll).toEqual(readAllBody);
		expect(
			(afterAll as { notifications: Array<{ unread?: boolean }> }).notifications.every(
				(row) => row.unread === false,
			),
		).toBe(true);

		const requestsBefore = await githubCount();
		const rowsBefore = d1Rows(
			"SELECT kind,payload FROM refresh_snapshots WHERE kind LIKE 'factory%' ORDER BY kind",
		);
		for (const path of ["/api/factory", "/api/factory/repos/octocat/hello-world/commits"]) {
			const response = await api(path);
			expect(response.status).toBe(200);
			const data = await response.json();
			noSecrets(data);
			if (path.endsWith("/commits"))
				expect(data).toMatchObject({ items: [], coverage: { status: "pending", fetchedAt: null } });
		}
		expect(await githubCount()).toBe(requestsBefore);
		expect(
			d1Rows("SELECT kind,payload FROM refresh_snapshots WHERE kind LIKE 'factory%' ORDER BY kind"),
		).toEqual(rowsBefore);

		const starsBefore = await githubCount();
		const save = (path: string, body: unknown) =>
			api(path, {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		expect(
			(await save("/api/repos/octocat/hello-world/star", { account_id: account.id, enabled: true }))
				.status,
		).toBe(200);
		expect(d1Rows(`SELECT repo FROM repo_stars WHERE account_id=${quote(account.id)}`)).toEqual([
			{ repo: "octocat/hello-world" },
		]);
		for (const path of [
			"repos",
			"issues",
			"prs",
			"alerts",
			"notifications",
			"insights",
			"ci",
			"factory",
		]) {
			const scoped = await api(`/api/${path}?scope=starred`);
			expect(scoped.status, path).toBe(200);
			const body = (await scoped.json()) as { account_id: string; freshness: { total: number } };
			expect(body.account_id).toBe(account.id);
			expect(body.freshness, path).toBeDefined();
			expect((await api(`/api/${path}?scope=unknown`)).status, path).toBe(400);
		}
		expect(await githubCount()).toBe(starsBefore);
		expect(
			(
				await save("/api/repos/octocat/hello-world/star", {
					account_id: account.id,
					enabled: false,
				})
			).status,
		).toBe(200);
		for (const [path, key] of [
			["repos", "repos"],
			["issues", "issues"],
			["prs", "pull_requests"],
			["insights", "insights"],
			["ci", "repos"],
			["factory", "repos"],
		]) {
			const empty = (await (await api(`/api/${path}?scope=starred`)).json()) as Record<
				string,
				unknown
			>;
			expect(empty[String(key)], path).toEqual([]);
			expect(empty.freshness, path).toMatchObject({ total: 0, missing: 0, latestAt: null });
		}
		expect((await (await api("/api/repos?scope=all")).json()).repos.length).toBeGreaterThan(0);
		expect(
			(await save("/api/repos/octocat/hello-world/star", { account_id: account.id, enabled: true }))
				.status,
		).toBe(200);
		expect(await githubCount()).toBe(starsBefore);
		expect(
			(await save("/api/repos/octocat/missing/star", { account_id: account.id, enabled: true }))
				.status,
		).toBe(404);
		expect((await api("/api/repos/octocat/hello-world/star")).status).toBe(405);
		expect(await githubCount()).toBe(starsBefore);
		const created2 = await api("/api/accounts", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ token: PAT_2 }),
		});
		expect(created2.status).toBe(201);
		const account2 = (await created2.json()) as { id: string; login?: string; is_active?: boolean };
		expect(account2.login).toBe("hubot");
		expect(account2.is_active).toBe(false);
		const activated = await api(`/api/accounts/${account2.id}/activate`, {
			method: "POST",
			headers: { origin },
		});
		expect(activated.status).toBe(200);
		expect(await activated.json()).toMatchObject({ id: account2.id, is_active: true });
		expect((await api("/api/repos")).status).toBe(409);
		expect(d1Rows(`SELECT repo FROM repo_stars WHERE account_id=${quote(account2.id)}`)).toEqual(
			[],
		);
		expect(
			(await api(`/api/accounts/${account.id}/activate`, { method: "POST", headers: { origin } }))
				.status,
		).toBe(200);
		expect((await api("/api/repos")).status).toBe(200);
		expect(
			(await api(`/api/accounts/${account.id}`, { method: "DELETE", headers: { origin } })).status,
		).toBe(204);
		expect((await api("/api/repos")).status).toBe(409);
		expect(d1Rows(`SELECT * FROM refresh_snapshots WHERE account_id = '${account.id}'`)).toEqual(
			[],
		);
		expect(d1Rows(`SELECT * FROM repo_stars WHERE account_id = '${account.id}'`)).toEqual([]);
		expect(d1Rows(`SELECT * FROM refresh_schedules WHERE account_id = '${account.id}'`)).toEqual(
			[],
		);
	});
});
