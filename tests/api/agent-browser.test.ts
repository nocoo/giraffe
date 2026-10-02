import { expect, it } from "vitest";

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
it("uses browser Access and CSRF for Agent requests and removes old cloud endpoints", async () => {
	const created = await call("accounts", "POST", { token: `ghp_${"A".repeat(36)}` });
	expect(created.ok).toBe(true);
	const account = (await created.json()) as { id: string };
	await call(`accounts/${account.id}/activate`, "POST");
	const prefix = `agent/accounts/${account.id}`;
	const input = {
		type: "analysis-request",
		status: "pending",
		payload: { scope: "global", repository: null, domains: ["issues", "prs", "ci", "cd"] },
	};
	expect((await call(`${prefix}/jobs`, "POST", input, "https://evil.test")).status).toBe(403);
	const response = await call(`${prefix}/jobs`, "POST", input);
	expect(response.status).toBe(201);
	const item = ((await response.json()) as { item: { id: string } }).item;
	expect((await call(`${prefix}/jobs?type=analysis-request`)).status).toBe(200);
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
		id: "repair-control",
		type: "repair-control",
		status: "paused",
		repository: null,
		source_version: null,
		payload: { paused: true },
	};
	expect((await call(path, "POST", input, "https://evil.test")).status).toBe(403);
	const result = await call(path, "POST", input);
	expect(result.status).toBe(201);
	expect(await (await call(`${path}/repair-control`)).json()).toMatchObject({
		item: { revision: 1, payload: { paused: true } },
	});
	expect(
		(
			await call(`${path}/repair-control`, "PATCH", {
				revision: 1,
				status: "enabled",
				payload: { paused: false },
			})
		).status,
	).toBe(200);
	expect(
		(
			await call(`${path}/repair-control`, "PATCH", {
				revision: 1,
				status: "paused",
				payload: { paused: true },
			})
		).status,
	).toBe(409);
	expect((await call(`${path}/repair-control?revision=2`, "DELETE")).status).toBe(204);
});
