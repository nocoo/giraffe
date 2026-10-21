import { expect, it } from "vitest";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const jwt = process.env.GIRAFFE_JWT ?? "";
const origin = "https://giraffe.dev.hexly.ai";
async function browser(path: string, method = "GET", body?: unknown) {
	return fetch(`${base}/api/${path}`, {
		method,
		headers: {
			origin,
			"content-type": "application/json",
			...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
it("retains machine bearer CRUD and retires PKCE over real local HTTP", async () => {
	const existing = (await (await browser("accounts")).json()) as {
		accounts: { id: string }[];
	};
	const response = await browser("accounts", "POST", { token: `ghp_${"A".repeat(36)}` });
	expect(response.ok).toBe(true);
	const account = (await response.json()) as { id: string };
	const created = await browser("tokens", "POST", {
		account_id: account.id,
		label: "local API acceptance",
		scopes: ["observations:read", "agent:read", "agent:write", "app:read", "app:write"],
		expires_in_days: 90,
	});
	expect(created.status).toBe(201);
	const token = (await created.json()) as { id: string; token: string };
	const tokenIds = [token.id];
	const prefix = `v1/accounts/${account.id}`;
	const machine = (path: string, method = "GET", body?: unknown, bearer = token.token) =>
		fetch(`${base}/api/${path}`, {
			method,
			headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	try {
		expect((await machine("v1/me", "GET", undefined, "invalid")).status).toBe(401);
		expect((await fetch(`${base}/api/v1/me`)).status).toBe(401);
		expect(await (await machine("v1/me")).json()).toMatchObject({
			account_id: account.id,
			login: "octocat",
		});
		expect((await machine(`v1/accounts/${"z".repeat(21)}/repos`)).status).toBe(403);
		const sources = await machine(`${prefix}/sources`);
		expect(sources.status).toBe(200);
		expect(sources.headers.get("cache-control")).toBe("private, no-store");
		expect(await sources.json()).toMatchObject({
			account_id: account.id,
			repositories: expect.any(Array),
			sources: expect.any(Array),
		});
		expect((await machine(`${prefix}/sources?since=2026-01-01T00%3A00%3A00Z`)).status).toBe(200);
		expect((await machine(`${prefix}/sources?since=invalid`)).status).toBe(400);
		expect((await machine(`${prefix}/sources?repository=outside%2Fcatalog`)).status).toBe(404);
		expect((await machine(`${prefix}/sources`, "POST", {})).status).toBe(405);
		expect((await machine(`${prefix}/sources`, "GET", undefined, "invalid")).status).toBe(401);
		expect((await machine(`v1/accounts/${"z".repeat(21)}/sources`)).status).toBe(403);
		for (const path of [
			"v1/me",
			...[
				"sources",
				"repos",
				"issues",
				"prs",
				"ci",
				"factory",
				"contributions",
				"settings",
				"refresh-runs",
				"repos/nocoo/app",
				...[
					"details",
					"issues",
					"prs",
					"actions",
					"releases",
					"traffic",
					"security",
					"languages",
					"contributors",
				].map((resource) => `repos/nocoo/app/${resource}`),
				...["commits", "issues", "prs", "actions", "releases", "alerts", "dependencies"].map(
					(stream) => `factory/repos/nocoo/app/${stream}`,
				),
				...["records", "reports", "jobs"].flatMap((collection) => [
					`agent/${collection}`,
					`agent/${collection}/saved`,
				]),
			].map((path) => `${prefix}/${path}`),
		]) {
			const invalid = await machine(`${path}?x=1`);
			expect.soft(invalid.status, path).toBe(400);
			expect.soft(await invalid.json(), path).toMatchObject({
				error: { code: "validation_failed", message: expect.any(String) },
			});
		}
		for (const kind of ["records", "reports", "jobs"]) {
			const path = `${prefix}/agent/${kind}`;
			const id = `acceptance-${kind}`;
			expect(
				(
					await machine(path, "POST", {
						id,
						type: "acceptance",
						status: "pending",
						payload: { safe: true },
					})
				).status,
			).toBe(201);
			expect((await machine(`${path}?limit=1&type=acceptance&status=pending`)).status).toBe(200);
			expect((await machine(`${path}/${id}`)).status).toBe(200);
			expect(
				(await machine(`${path}/${id}`, "PATCH", { revision: 1, status: "completed" })).status,
			).toBe(200);
			expect(
				(await machine(`${path}/${id}`, "PATCH", { revision: 1, status: "failed" })).status,
			).toBe(409);
			expect((await machine(`${path}/${id}?revision=2`, "DELETE")).status).toBe(204);
		}
		const beforeRetirement = await (await browser(`tokens?account_id=${account.id}`)).json();
		const consent = await browser("cli/authorize", "POST", {
			account_id: account.id,
			label: "PKCE local acceptance",
			scopes: ["agent:read"],
			expires_in_days: 1,
			redirect_uri: "http://localhost:23456/callback",
			state: "safe",
			code_challenge: "x".repeat(43),
			code_challenge_method: "S256",
			consent: true,
		});
		expect(consent.status).toBe(404);
		expect(await consent.json()).toMatchObject({ error: { code: "not_found" } });
		const exchange = {
			code: `giraffe_code_${"x".repeat(43)}`,
			code_verifier: "x".repeat(43),
			redirect_uri: "http://localhost:23456/callback",
		};
		const tokenless = await fetch(`${base}/api/v1/auth/exchange`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(exchange),
		});
		expect(tokenless.status).toBe(401);
		expect(await tokenless.json()).toMatchObject({ error: { code: "token_unauthorized" } });
		for (const [method, status] of [
			["GET", 404],
			["POST", 405],
		] as const) {
			const retired = await machine(
				"v1/auth/exchange",
				method,
				method === "POST" ? exchange : undefined,
			);
			expect(retired.status).toBe(status);
			expect(await retired.text()).not.toMatch(/giraffe_|redirect_uri|code_verifier/);
		}
		expect(await (await browser(`tokens?account_id=${account.id}`)).json()).toEqual(
			beforeRetirement,
		);
		expect(
			(
				await browser("tokens", "POST", {
					account_id: account.id,
					label: "Invalid expiry",
					scopes: ["agent:read"],
					expires_in_days: 91,
				})
			).status,
		).toBe(400);
		const readonly = await browser("tokens", "POST", {
			account_id: account.id,
			label: "External read-only bot",
			scopes: ["agent:read"],
			expires_in_days: 1,
		});
		expect(readonly.status).toBe(201);
		const readToken = (await readonly.json()) as { id: string; token: string };
		tokenIds.push(readToken.id);
		expect((await machine(`${prefix}/sources`, "GET", undefined, readToken.token)).status).toBe(
			403,
		);
		expect(
			(
				await machine(
					`${prefix}/agent/records`,
					"POST",
					{ type: "acceptance", status: "pending", payload: {} },
					readToken.token,
				)
			).status,
		).toBe(403);
	} finally {
		for (const id of tokenIds)
			expect((await browser(`tokens/${id}`, "DELETE", { account_id: account.id })).status).toBe(
				204,
			);
		if (!existing.accounts.some((item) => item.id === account.id))
			expect((await browser(`accounts/${account.id}`, "DELETE")).status).toBe(204);
	}
	expect((await machine("v1/me")).status).toBe(401);
});
