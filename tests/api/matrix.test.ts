import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
	"/api/digest",
	"/api/repos/octocat/hello-world",
	"/api/repos/octocat/hello-world/actions",
	"/api/repos/octocat/hello-world/traffic",
	"/api/repos/octocat/hello-world/security",
	"/api/repos/octocat/hello-world/issues",
	"/api/repos/octocat/hello-world/prs",
	"/api/repos/octocat/hello-world/releases",
	"/api/repos/octocat/hello-world/languages",
	"/api/repos/octocat/hello-world/contributors",
];

const WRITES: Array<[string, string, RequestInit]> = [
	[
		"POST",
		"/api/accounts",
		{ headers: { "content-type": "application/json" }, body: JSON.stringify({ token: PAT }) },
	],
	["POST", "/api/accounts/x/activate", {}],
	["DELETE", "/api/accounts/x", {}],
	[
		"POST",
		"/api/refresh",
		{ headers: { "content-type": "application/json" }, body: JSON.stringify({ kinds: ["repos"] }) },
	],
	[
		"POST",
		"/api/notifications/read",
		{ headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "123" }) },
	],
	["POST", "/api/notifications/read-all", {}],
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
	const raw = execFileSync(
		join(root, "node_modules/.bin/wrangler"),
		[
			"d1",
			"execute",
			"giraffe-db",
			"--local",
			`--persist-to=${persist}`,
			`--config=${config}`,
			"--json",
			"--command",
			sql,
		],
		{ encoding: "utf8", cwd: root },
	);
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
}

describe("api method matrix", () => {
	it("covers suite A/B contracts for every listed path", async () => {
		if (suite === "B") {
			for (const path of GETS) {
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
		expect(
			(
				await api("/api/accounts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token: PAT }),
				})
			).status,
		).toBe(403);
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
		};
		expect(account).toMatchObject({
			id: expect.any(String),
			login: "octocat",
			avatar_url: expect.any(String),
			token_last4: expect.any(String),
			scopes: expect.any(String),
			is_active: true,
		});
		expect(account).toHaveProperty("capabilities");
		noSecrets(account);
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
			is_active: true,
		});
		noSecrets(listedBody);
		const logPath = process.env.GIRAFFE_WRANGLER_LOG;
		expect(
			(
				await api("/api/accounts", {
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ token: "nope" }),
				})
			).status,
		).toBe(400);
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
		}

		const refreshed = await api("/api/refresh", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(refreshed.status).toBe(200);
		const refreshBody = (await refreshed.json()) as {
			fetched_at?: string;
			kinds?: string[];
			truncated_kinds?: string[];
		};
		expect(refreshBody.fetched_at).toEqual(expect.any(String));
		expect(refreshBody.kinds).toEqual(expect.arrayContaining(["repos", "issues", "prs", "alerts"]));
		expect(Array.isArray(refreshBody.truncated_kinds)).toBe(true);
		noSecrets(refreshBody);
		const repoRefresh = await api("/api/refresh", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({
				kinds: [
					"repo:octocat/hello-world:details",
					"repo:octocat/hello-world:actions",
					"repo:octocat/hello-world:traffic",
					"repo:octocat/hello-world:security",
					"repo:octocat/hello-world:issues",
					"repo:octocat/hello-world:prs",
					"repo:octocat/hello-world:releases",
					"repo:octocat/hello-world:languages",
					"repo:octocat/hello-world:contributors",
				],
			}),
		});
		expect(repoRefresh.status).toBe(200);
		const repoRefreshBody = (await repoRefresh.json()) as { kinds?: string[] };
		expect(repoRefreshBody.kinds?.length).toBeGreaterThan(0);
		noSecrets(repoRefreshBody);
		const reposGet = await api("/api/repos");
		expect(reposGet.status).toBe(200);
		const reposBody = (await reposGet.json()) as Record<string, unknown> & {
			repos: Array<Record<string, unknown>>;
		};
		snapshotMeta(reposBody);
		expect(reposBody.truncated).toBe(false);
		expect(reposBody.repos[0]).toMatchObject({
			name_with_owner: "octocat/hello-world",
			name: "hello-world",
			owner_login: "octocat",
			stargazer_count: 1,
			fork_count: 0,
			url: "https://github.com/octocat/hello-world",
		});
		noSecrets(reposBody);
		const detailsBody = (await (await api("/api/repos/octocat/hello-world")).json()) as Record<
			string,
			unknown
		>;
		snapshotMeta(detailsBody);
		expect(detailsBody).toMatchObject({
			default_branch: "main",
			url: "https://github.com/octocat/hello-world",
		});
		noSecrets(detailsBody);
		const issuesBody = (await (await api("/api/issues")).json()) as Record<string, unknown>;
		snapshotMeta(issuesBody);
		expect(Array.isArray(issuesBody.issues)).toBe(true);
		const prsBody = (await (await api("/api/prs")).json()) as Record<string, unknown>;
		snapshotMeta(prsBody);
		expect(Array.isArray(prsBody.pull_requests)).toBe(true);
		const alertsBody = (await (await api("/api/alerts")).json()) as Record<string, unknown>;
		snapshotMeta(alertsBody);
		expect(alertsBody).toMatchObject({
			unavailable: expect.any(Boolean),
			dependabot_open: expect.any(Number),
			code_scanning_open: expect.any(Number),
		});
		expect(Array.isArray(alertsBody.items)).toBe(true);
		const insightsBody = (await (await api("/api/insights")).json()) as Record<string, unknown>;
		snapshotMeta(insightsBody);
		expect(Array.isArray(insightsBody.insights)).toBe(true);
		const digestBody = (await (await api("/api/digest")).json()) as Record<string, unknown>;
		snapshotMeta(digestBody);
		expect(digestBody).toMatchObject({
			day: expect.any(String),
			baseline_missing: expect.any(Boolean),
		});
		expect(Array.isArray(digestBody.repos)).toBe(true);
		const trafficBody = (await (
			await api("/api/repos/octocat/hello-world/traffic")
		).json()) as Record<string, unknown>;
		snapshotMeta(trafficBody);
		expect(trafficBody).toMatchObject({
			forbidden: false,
			views: { count: expect.any(Number), uniques: expect.any(Number) },
			clones: { count: expect.any(Number), uniques: expect.any(Number) },
		});
		const securityBody = (await (
			await api("/api/repos/octocat/hello-world/security")
		).json()) as Record<string, unknown>;
		snapshotMeta(securityBody);
		expect(securityBody).toMatchObject({
			unavailable: expect.any(Boolean),
			dependabot_open: expect.any(Number),
			code_scanning_open: expect.any(Number),
		});
		const languagesBody = (await (
			await api("/api/repos/octocat/hello-world/languages")
		).json()) as Record<string, unknown>;
		snapshotMeta(languagesBody);
		expect(languagesBody.languages).toMatchObject({ TypeScript: 1 });
		const actionsBody = (await (
			await api("/api/repos/octocat/hello-world/actions")
		).json()) as Record<string, unknown>;
		snapshotMeta(actionsBody);
		expect(Array.isArray(actionsBody.runs)).toBe(true);
		const releasesBody = (await (
			await api("/api/repos/octocat/hello-world/releases")
		).json()) as Record<string, unknown>;
		snapshotMeta(releasesBody);
		expect(Array.isArray(releasesBody.releases)).toBe(true);
		const contributorsBody = (await (
			await api("/api/repos/octocat/hello-world/contributors")
		).json()) as Record<string, unknown>;
		snapshotMeta(contributorsBody);
		expect(Array.isArray(contributorsBody.contributors)).toBe(true);
		const repoIssues = (await (
			await api("/api/repos/octocat/hello-world/issues")
		).json()) as Record<string, unknown>;
		snapshotMeta(repoIssues);
		expect(Array.isArray(repoIssues.issues)).toBe(true);
		const repoPrs = (await (await api("/api/repos/octocat/hello-world/prs")).json()) as Record<
			string,
			unknown
		>;
		snapshotMeta(repoPrs);
		expect(Array.isArray(repoPrs.pull_requests)).toBe(true);
		const oneKind = await api("/api/refresh", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ kinds: ["alerts"] }),
		});
		expect(oneKind.status).toBe(200);
		expect(await oneKind.json()).toEqual(await (await api("/api/alerts")).json());
		const notifSnap = (await (await api("/api/notifications")).json()) as Record<
			string,
			unknown
		> & {
			notifications: Array<Record<string, unknown>>;
		};
		snapshotMeta(notifSnap);
		expect(notifSnap.notifications[0]).toMatchObject({
			id: "123",
			unread: true,
			name_with_owner: "octocat/hello-world",
		});
		const snapRows = d1Rows("SELECT kind, fetched_at FROM snapshots ORDER BY kind");
		expect(snapRows.length).toBeGreaterThan(0);
		for (const row of snapRows) {
			expect(String(row.fetched_at).length).toBeGreaterThan(10);
		}
		const accountRows = d1Rows("SELECT login, last_used_at, is_active FROM accounts");
		expect(accountRows[0]).toMatchObject({ login: "octocat", is_active: 1 });
		expect(String(accountRows[0]?.last_used_at ?? "").length).toBeGreaterThan(10);
		const beforeRows = d1Rows("SELECT kind, payload, fetched_at FROM snapshots ORDER BY kind");
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
		expect(d1Rows("SELECT kind, payload, fetched_at FROM snapshots ORDER BY kind")).toEqual(
			beforeRows,
		);
		expect(d1Rows("SELECT login, last_used_at, is_active FROM accounts")).toEqual(beforeAccounts);
		const readRes = await api("/api/notifications/read", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ id: "123" }),
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
			headers: { origin },
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
		expect(
			(await api(`/api/accounts/${account.id}/activate`, { method: "POST", headers: { origin } }))
				.status,
		).toBe(200);
		expect((await api("/api/repos")).status).toBe(200);
		expect(
			(await api(`/api/accounts/${account.id}`, { method: "DELETE", headers: { origin } })).status,
		).toBe(204);
		expect((await api("/api/repos")).status).toBe(409);
		expect(d1Rows(`SELECT * FROM snapshots WHERE account_id = '${account.id}'`)).toEqual([]);
		expect(d1Rows(`SELECT * FROM snapshot_days WHERE account_id = '${account.id}'`)).toEqual([]);
	});
});
