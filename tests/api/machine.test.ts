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
it("exercises machine bearer CRUD and PKCE over real local HTTP, independently of Access sessions", async () => {
	const response = await browser("accounts", "POST", { token: `ghp_${"A".repeat(36)}` });
	expect(response.ok).toBe(true);
	const account = (await response.json()) as { id: string };
	const created = await browser("tokens", "POST", {
		account_id: account.id,
		label: "local API acceptance",
		scopes: ["observations:read", "agent:read", "agent:write", "app:read", "app:write"],
		expires_in_days: 1,
	});
	expect(created.status).toBe(201);
	const token = (await created.json()) as { id: string; token: string };
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
		const verifier = "x".repeat(43);
		const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		const challenge = Buffer.from(hash).toString("base64url");
		const consent = await browser("cli/authorize", "POST", {
			account_id: account.id,
			label: "PKCE local acceptance",
			scopes: ["agent:read"],
			expires_in_days: 1,
			redirect_uri: "http://localhost:23456/callback",
			state: "safe",
			code_challenge: challenge,
			code_challenge_method: "S256",
			consent: true,
		});
		expect(consent.status).toBe(200);
		const url = new URL(((await consent.json()) as { redirect_uri: string }).redirect_uri);
		expect([...url.searchParams.keys()].sort()).toEqual(["code", "state"]);
		const exchange = {
			code: url.searchParams.get("code"),
			code_verifier: verifier,
			redirect_uri: "http://localhost:23456/callback",
		};
		const exchanged = await machine("v1/auth/exchange", "POST", exchange, "");
		expect(exchanged.status).toBe(200);
		const readToken = (await exchanged.json()) as { token: string };
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
		expect((await machine("v1/auth/exchange", "POST", exchange, "")).status).toBe(400);
		const list = (await (await browser(`tokens?account_id=${account.id}`)).json()) as {
			items: { id: string; label: string }[];
		};
		for (const t of list.items.filter((t) => t.label === "PKCE local acceptance"))
			expect((await browser(`tokens/${t.id}`, "DELETE", { account_id: account.id })).status).toBe(
				204,
			);
	} finally {
		expect((await browser(`tokens/${token.id}`, "DELETE", { account_id: account.id })).status).toBe(
			204,
		);
	}
	expect((await machine("v1/me")).status).toBe(401);
});
