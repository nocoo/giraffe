import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { executeD1FixtureSync } from "../fixtures/d1";
import { dailyReport } from "../fixtures/daily-report";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const writer = `giraffe_${randomBytes(32).toString("base64url")}`;
const reader = `giraffe_${randomBytes(32).toString("base64url")}`;
const wrong = `giraffe_${randomBytes(32).toString("base64url")}`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
let seeded = false;
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
	const result = executeD1FixtureSync(command, { persist, config });
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(item) => item.results,
	);
}
const marker = () =>
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
const request = (
	resource: string,
	method = "GET",
	body?: unknown,
	token = writer,
	headers: Record<string, string> = {},
	selected = account,
) =>
	fetch(`${base}/api/v1/accounts/${selected}/agent/${resource}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
const input = (date = "2026-10-22", headline = "Daily delivery review") => ({
	type: "github-daily",
	status: "completed",
	payload: dailyReport(date, headline).payload,
});

beforeAll(() => {
	marker();
	const now = new Date().toISOString();
	const mint = (token: string, scopes: string[], id: string) =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(`${account}-${id}`)},${quote(account)},${quote(createHash("sha256").update(token).digest("hex"))},'daily L2',${quote(JSON.stringify(scopes))},'local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`;
	seeded = true;
	rows(
		`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(`daily-${account}`)},'fake','fake',${quote(now)},${quote(now)});${mint(writer, ["agent:read", "agent:write"], "writer")}${mint(reader, ["agent:read"], "reader")}${mint(wrong, ["app:read", "app:write", "observations:read"], "wrong")}`,
	);
});
afterAll(() => {
	if (seeded) {
		marker();
		rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
	}
});

it("R8 HTTP creates one daily per date, versions replacements and rejects invalid writes without changing latest", async () => {
	const created = await request("reports", "POST", input());
	expect(created.status).toBe(201);
	const original = (await created.json()).item;
	expect(original).toMatchObject({ id: "github-daily-2026-10-22", revision: 1, repository: null });
	const updated = await request("reports", "POST", input("2026-10-22", "Revised daily review"));
	expect(updated.status).toBe(200);
	const revised = (await updated.json()).item;
	expect(revised).toMatchObject({ id: original.id, revision: 2, created_at: original.created_at });
	for (const patch of [
		{ ...input(), repository: "owner/app" },
		{ ...input(), payload: { ...input().payload, scope: "global" } },
		{ ...input(), payload: { ...input().payload, links: { xray: "javascript:alert(1)" } } },
		{
			...input(),
			payload: {
				...input().payload,
				sections: [
					{
						...input().payload.sections[0],
						items: Array.from({ length: 51 }, () => input().payload.sections[0].items[0]),
					},
				],
			},
		},
	])
		expect((await request("reports", "POST", patch)).status).toBe(400);
	expect(
		(await request(`reports/${original.id}`, "PATCH", { revision: 1, payload: input().payload }))
			.status,
	).toBe(409);
	const latest = await request("reports/latest?type=github-daily", "GET", undefined, reader);
	expect(latest.status).toBe(200);
	expect(await latest.json()).toMatchObject({
		account_id: account,
		item: revised,
		invalidCount: 0,
	});
	const etag = latest.headers.get("etag");
	expect(etag).toMatch(/^".+"$/);
	const cached = await request("reports/latest?type=github-daily", "GET", undefined, reader, {
		"if-none-match": etag ?? "",
	});
	expect(cached.status).toBe(304);
	expect(await cached.text()).toBe("");
	expect(cached.headers.get("cache-control")).toBe("private, no-store");
	expect(cached.headers.get("vary")).toContain("Authorization");
});

it("R8 HTTP preserves generic report CRUD and the latest resource ID while selecting exact generation instants", async () => {
	const resources = [
		{
			id: "latest",
			payload: { generatedAt: "2026-10-22T00:00:00.00010Z", opaque: { keep: true } },
		},
		{ id: "aa-newer", payload: { generatedAt: "2026-10-22T08:00:00.00011+08:00" } },
	];
	for (const value of resources)
		expect(
			(await request("reports", "POST", { ...value, type: "legacy-report", status: "ready" }))
				.status,
		).toBe(201);
	expect(
		(await request("reports", "POST", { ...resources[0], type: "legacy-report", status: "ready" }))
			.status,
	).toBe(409);
	expect(await (await request("reports/latest")).json()).toMatchObject({
		item: { id: "latest", payload: resources[0].payload },
	});
	expect(await (await request("reports/latest?type=legacy-report")).json()).toMatchObject({
		item: { id: "aa-newer" },
	});
	const page = await (await request("reports?type=legacy-report&limit=1")).json();
	expect(page).toMatchObject({
		account_id: account,
		items: [{ id: "aa-newer" }],
		nextCursor: "aa-newer",
	});
	expect(
		await (await request(`reports?type=legacy-report&cursor=${page.nextCursor}`)).json(),
	).toMatchObject({ items: [{ id: "latest" }], nextCursor: null });
	expect(
		(await request("reports/latest", "PATCH", { revision: 1, status: "completed" })).status,
	).toBe(200);
	expect((await request("reports/latest?revision=2", "DELETE")).status).toBe(204);
	expect(await (await request("reports/latest?type=not-present")).json()).toMatchObject({
		item: null,
	});
});

it("R8 HTTP machine and browser latest share history, hide legacy invalid daily rows and never mutate GET state", async () => {
	marker();
	const prior = rows("SELECT id FROM accounts WHERE is_active=1")[0]?.id;
	const now = new Date().toISOString();
	rows(
		`UPDATE accounts SET is_active=0 WHERE is_active=1; UPDATE accounts SET is_active=1 WHERE id=${quote(account)}; INSERT INTO agent_resources(account_id,collection,id,repository,type,status,payload,created_at,updated_at) VALUES(${quote(account)},'reports','legacy-invalid',NULL,'github-daily','completed','{}',${quote(now)},${quote(now)});`,
	);
	try {
		const before = rows(
			`SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id; SELECT * FROM agent_resources WHERE account_id=${quote(account)} ORDER BY id;`,
		);
		const calls = await (await fetch("http://127.0.0.1:17046/_count")).text();
		const jwt = process.env.GIRAFFE_JWT;
		const headers = jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {};
		const prefix = `${base}/api/agent/accounts/${account}`;
		const browser = await fetch(`${prefix}/reports/latest?type=github-daily`, { headers });
		expect(browser.status).toBe(200);
		const latest = await browser.json();
		expect(latest.invalidCount).toBe(1);
		expect(
			await (await request("reports/latest?type=github-daily", "GET", undefined, reader)).json(),
		).toEqual(latest);
		const history = await (await fetch(`${prefix}/analysis/daily`, { headers })).json();
		expect(history).toMatchObject({ account_id: account, items: [latest.item], invalidCount: 1 });
		const cached = await fetch(`${prefix}/reports/latest?type=github-daily`, {
			headers: { ...headers, "if-none-match": browser.headers.get("etag") ?? "" },
		});
		expect(cached.status).toBe(304);
		expect(cached.headers.get("cache-control")).toBe("private, no-store");
		expect(cached.headers.get("vary")).toContain("Cf-Access-Jwt-Assertion");
		expect(cached.headers.get("referrer-policy")).toBe("no-referrer");
		for (const token of [wrong, "invalid"])
			expect(
				(
					await request("reports/latest?type=github-daily", "GET", undefined, token, {
						"if-none-match": "*",
					})
				).status,
			).toBe(token === wrong ? 403 : 401);
		expect((await request("reports", "POST", input(), reader)).status).toBe(403);
		expect(
			(
				await request(
					"reports/latest?type=github-daily",
					"GET",
					undefined,
					reader,
					{},
					"z".repeat(21),
				)
			).status,
		).toBe(403);
		for (const query of [
			"type=github-daily&unknown=1",
			"type=github-daily&type=other",
			"type=bad!",
		])
			expect((await request(`reports/latest?${query}`)).status).toBe(400);
		expect((await fetch(`${prefix}/analysis/daily?x=1`, { headers })).status).toBe(400);
		expect(
			(
				await fetch(
					`${base}/api/agent/accounts/${"z".repeat(21)}/reports/latest?type=github-daily`,
					{ headers },
				)
			).status,
		).toBe(409);
		expect(
			rows(
				`SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id; SELECT * FROM agent_resources WHERE account_id=${quote(account)} ORDER BY id;`,
			),
		).toEqual(before);
		expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(calls);
	} finally {
		marker();
		rows(
			`UPDATE accounts SET is_active=0 WHERE id=${quote(account)};${typeof prior === "string" ? `UPDATE accounts SET is_active=1 WHERE id=${quote(prior)};` : ""}`,
		);
	}
});
