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
	return fetch(`${base}${path}`, { ...init, headers });
}

async function githubCount(): Promise<number> {
	const res = await fetch("http://127.0.0.1:17046/_count");
	return Number(await res.text());
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

		expect((await api("/api/me")).status).toBe(200);
		expect((await api("/api/accounts")).status).toBe(200);
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
		const account = (await created.json()) as { id: string; token_last4?: string };
		expect(JSON.stringify(account)).not.toContain(PAT);
		expect(
			(
				await api("/api/accounts", {
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ token: "nope" }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await api("/api/accounts", {
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ token: PAT_401 }),
				})
			).status,
		).toBe(401);
		expect(
			(
				await api("/api/accounts", {
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ token: PAT_SCOPE }),
				})
			).status,
		).toBe(400);

		const refreshed = await api("/api/refresh", {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(refreshed.status).toBe(200);
		await api("/api/refresh", {
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
		const before = await githubCount();
		for (const path of GETS.filter((p) => p !== "/api/me" && p !== "/api/accounts")) {
			const res = await api(path);
			expect([200, 409]).toContain(res.status);
		}
		expect(await githubCount()).toBe(before);
		expect(
			(
				await api("/api/notifications/read", {
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ id: "123" }),
				})
			).status,
		).toBe(200);
		expect(
			(await api("/api/notifications/read-all", { method: "POST", headers: { origin } })).status,
		).toBe(200);
		expect(
			(await api(`/api/accounts/${account.id}/activate`, { method: "POST", headers: { origin } }))
				.status,
		).toBe(200);
		expect(
			(await api(`/api/accounts/${account.id}`, { method: "DELETE", headers: { origin } })).status,
		).toBe(204);
	});
});
