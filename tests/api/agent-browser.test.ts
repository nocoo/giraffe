import { afterAll, beforeAll, expect, it } from "vitest";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045",
	jwt = process.env.GIRAFFE_JWT ?? "",
	origin = "https://giraffe.dev.hexly.ai";
const call = (path: string, method = "GET", body?: unknown, from = origin) =>
	fetch(`${base}/api/${path}`, {
		method,
		headers: {
			origin: from,
			"content-type": "application/json",
			...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
let originalAccounts: { id: string; is_active: boolean }[] = [];
beforeAll(async () => {
	const response = await call("accounts");
	expect(response.status).toBe(200);
	originalAccounts = ((await response.json()) as { accounts: typeof originalAccounts }).accounts;
});
afterAll(async () => {
	const response = await call("accounts");
	expect(response.status).toBe(200);
	const current = ((await response.json()) as { accounts: typeof originalAccounts }).accounts;
	for (const account of current)
		if (!originalAccounts.some((original) => original.id === account.id))
			expect((await call(`accounts/${account.id}`, "DELETE")).status).toBe(204);
	const active = originalAccounts.find((account) => account.is_active);
	if (active) expect((await call(`accounts/${active.id}/activate`, "POST")).status).toBe(200);
});
it("uses browser Access and CSRF for Agent requests and removes old cloud endpoints", async () => {
	const created = await call("accounts", "POST", { token: `ghp_${"A".repeat(36)}` });
	expect(created.ok).toBe(true);
	const account = (await created.json()) as { id: string };
	await call(`accounts/${account.id}/activate`, "POST");
	const prefix = `agent/accounts/${account.id}`;
	const input = {
		type: "work-run",
		status: "pending",
		payload: { scope: "global", repository: null, domains: ["issues", "prs", "ci", "cd"] },
	};
	expect((await call(`${prefix}/jobs`, "POST", input, "https://evil.test")).status).toBe(403);
	const response = await call(`${prefix}/jobs`, "POST", input);
	expect(response.status).toBe(201);
	const item = ((await response.json()) as { item: { id: string } }).item;
	expect((await call(`${prefix}/jobs?type=work-run`)).status).toBe(200);
	expect(
		(await call(`${prefix}/jobs/${item.id}`, "PATCH", { revision: 1, status: "cancelled" })).status,
	).toBe(200);
	expect((await call(`${prefix}/jobs/${item.id}?revision=2`, "DELETE")).status).toBe(204);
	expect((await call(`${prefix}/sources`)).status).toBe(200);
	for (const path of [
		"ai/settings",
		"repos/octocat/hello-world/assessment",
		"insights/assessments",
	])
		expect((await call(path)).status).toBe(404);
});

it("stores pause control as a revisioned record without granting local repair permissions", async () => {
	const created = await call("accounts", "POST", { token: `ghp_${"A".repeat(36)}` });
	expect(created.ok).toBe(true);
	const account = (await created.json()) as { id: string };
	await call(`accounts/${account.id}/activate`, "POST");
	const path = `agent/accounts/${account.id}/records`;
	const input = {
		id: "work-control",
		type: "work-control",
		status: "paused",
		repository: null,
		source_version: null,
		payload: { paused: true },
	};
	expect((await call(path, "POST", input, "https://evil.test")).status).toBe(403);
	const result = await call(path, "POST", input);
	expect(result.status).toBe(201);
	expect(await (await call(`${path}/work-control`)).json()).toMatchObject({
		item: { revision: 1, payload: { paused: true } },
	});
	expect(
		(
			await call(`${path}/work-control`, "PATCH", {
				revision: 1,
				status: "enabled",
				payload: { paused: false },
			})
		).status,
	).toBe(200);
	expect(
		(
			await call(`${path}/work-control`, "PATCH", {
				revision: 1,
				status: "paused",
				payload: { paused: true },
			})
		).status,
	).toBe(409);
	expect((await call(`${path}/work-control?revision=2`, "DELETE")).status).toBe(204);
});

it("reads the bounded analysis projection over local HTTP without changing generic history", async () => {
	const created = await call("accounts", "POST", { token: `ghp_${"A".repeat(36)}` });
	expect(created.ok).toBe(true);
	const account = (await created.json()) as { id: string };
	await call(`accounts/${account.id}/activate`, "POST");
	const prefix = `agent/accounts/${account.id}`;
	for (const domain of ["issues", "prs"])
		for (const [id, fraction] of [
			["z", "000100"],
			["y", "000200"],
			["x", "000300"],
			["a", "000400"],
		]) {
			const response = await call(`${prefix}/reports`, "POST", {
				id: `http-${domain}-${id}`,
				type: "github-analysis",
				status: "completed",
				payload: { scope: "global", domain, generatedAt: `2026-10-21T00:00:00.${fraction}Z` },
			});
			expect(response.status).toBe(201);
		}
	const response = await call(`${prefix}/analysis/reports`);
	expect(response.status).toBe(200);
	const projection = (await response.json()) as { account_id: string; items: { id: string }[] };
	expect(projection.account_id).toBe(account.id);
	expect(projection.items.map((item) => item.id)).toEqual([
		"http-issues-a",
		"http-issues-x",
		"http-issues-y",
		"http-prs-a",
		"http-prs-x",
		"http-prs-y",
	]);
	expect((await call(`${prefix}/analysis/reports?limit=100`)).status).toBe(400);
	const generic = await call(`${prefix}/reports?type=github-analysis&limit=100`);
	expect(generic.status).toBe(200);
	expect(((await generic.json()) as { items: unknown[] }).items).toHaveLength(8);
	for (const domain of ["issues", "prs"])
		for (const id of ["z", "y", "x", "a"])
			expect(
				(await call(`${prefix}/reports/http-${domain}-${id}?revision=1`, "DELETE")).status,
			).toBe(204);
});
