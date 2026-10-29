import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { quote, localD1Rows as rows } from "./local-d1";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const token = () => `giraffe_${randomBytes(32).toString("base64url")}`;
const writer = token();
const reader = token();
const observer = token();
const expired = token();
const revoked = token();
let seeded = false;
const request = (
	path: string,
	method = "GET",
	body?: unknown,
	bearer: string | null = writer,
	selected = account,
) =>
	fetch(`${base}/api/v1/accounts/${selected}/${path}`, {
		method,
		headers: {
			...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

beforeAll(() => {
	const now = new Date().toISOString();
	const mint = (raw: string, scopes: string[], suffix: string, expiry: string, revokedAt = "") =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at,revoked_at) VALUES(${quote(`${account}-${suffix}`)},${quote(account)},${quote(createHash("sha256").update(raw).digest("hex"))},'retirement L2',${quote(JSON.stringify(scopes))},'local test',${quote(suffix === "expired" ? "2024-01-01T00:00:00.000Z" : now)},${quote(expiry)},${revokedAt ? quote(revokedAt) : "NULL"});`;
	const expiry = new Date(Date.now() + 86400_000).toISOString();
	rows(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(`retired-${account}`)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
			mint(writer, ["app:read", "app:write"], "writer", expiry),
			mint(reader, ["app:read"], "reader", expiry),
			mint(observer, ["observations:read", "agent:read", "agent:write"], "observer", expiry),
			mint(expired, ["app:read", "app:write"], "expired", "2025-01-01T00:00:00.000Z"),
			mint(revoked, ["app:read", "app:write"], "revoked", expiry, now),
			`INSERT INTO factory_runs(id,account_id,request_key,status,payload,lease_token,lease_until,next_at,created_at,updated_at) VALUES(${quote(`old-${account}`)},${quote(account)},'old-request','paused','{"status":"paused"}','old-lease',${quote(expiry)},${quote(now)},${quote(now)},${quote(now)});`,
			`INSERT INTO refresh_schedules(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(${quote(account)},'daily',1,'08:00',0,'all',${quote(now)});`,
			`UPDATE refresh_schedule_times SET times='["08:00","19:00"]' WHERE account_id=${quote(account)} AND kind='daily';`,
			`INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(${quote(account)},'repos','{"repos":[],"truncated":false}',${quote(now)});`,
		].join("\n"),
	);
	seeded = true;
});

afterAll(() => {
	if (seeded) rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
});

const savedState = () =>
	rows(
		[
			"api_tokens",
			"factory_runs",
			"factory_state",
			"factory_resources",
			"factory_repo_state",
			"factory_repo_versions",
			"factory_version_refs",
			"factory_budget",
			"factory_storage",
			"factory_run_journal",
			"refresh_schedules",
			"catalog_refresh_schedules",
			"refresh_schedule_times",
			"snapshots",
			"agent_resources",
			"activity_publications",
			"activity_pages",
			"catalog_repositories",
			"catalog_changes",
			"catalog_state",
			"accounts",
		]
			.map((table) => `SELECT * FROM ${table} ORDER BY rowid;`)
			.join("\n"),
	);
const count = async () => (await fetch("http://127.0.0.1:17046/_count")).text();
const unavailable = async (response: Response, status = 404) => {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(response.headers.get("vary")).toContain("Authorization");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(await response.json()).toMatchObject({
		error: { code: status === 400 ? "validation_failed" : "not_found" },
	});
};

it("never revives legacy runs or modes when unified refresh is available", async () => {
	const before = savedState();
	const upstream = await count();
	expect((await request("refresh-runs/latest")).status).toBe(409);
	for (const kind of ["?kind=daily", "?kind=weekly", "?kind=catalog", "?kind=invalid&x=1"])
		await unavailable(await request(`refresh-runs/latest${kind}`), 400);
	for (const bearer of [writer, reader]) {
		const list = await request("refresh-runs", "GET", undefined, bearer);
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({
			items: [],
			collectionAvailable: true,
		});
		const settings = await request("settings", "GET", undefined, bearer);
		expect(settings.status).toBe(200);
		expect(await settings.json()).toMatchObject({
			account_id: account,
			schedules: [{ time: "03:00", timezone: "Asia/Shanghai", scope: "starred" }],
			collectionAvailable: true,
		});
	}
	for (const mode of ["catalog", "refresh"])
		for (const depth of ["quick", "deep", "full"])
			await unavailable(
				await request("refresh-runs", "POST", {
					requestKey: randomUUID(),
					mode,
					depth,
					scope: "all",
				}),
				400,
			);
	for (const action of ["pause", "resume", "cancel"])
		for (const id of [`old-${account}`, "missing"])
			await unavailable(await request(`refresh-runs/${id}/control`, "POST", { action }));
	for (const kind of ["daily", "weekly", "catalog"])
		for (const method of ["PUT", "DELETE"])
			await unavailable(
				await request(`schedules/${kind}`, method, { enabled: true, times: ["08:00"] }),
			);
	expect(savedState()).toEqual(before);
	expect(await count()).toBe(upstream);
});

it("authenticates and authorizes before returning retired collection responses without token activity writes", async () => {
	const before = savedState();
	const upstream = await count();
	for (const [path, method] of [
		["refresh-runs", "GET"],
		["refresh-runs/latest?kind=daily", "GET"],
		["settings", "GET"],
		["refresh-runs", "POST"],
		["refresh-runs/old/control", "POST"],
		["refresh-runs/old/cancel", "POST"],
		["schedules/daily", "PUT"],
		["schedules/weekly", "DELETE"],
	] as const) {
		for (const bearer of [null, "invalid", expired, revoked]) {
			const response = await request(path, method, undefined, bearer);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ error: { code: "token_unauthorized" } });
		}
		const denied = await request(path, method, undefined, observer);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: { code: "scope_forbidden" } });
		const crossAccount = await request(path, method, undefined, writer, "z".repeat(21));
		expect(crossAccount.status).toBe(403);
		expect(await crossAccount.json()).toMatchObject({ error: { code: "account_forbidden" } });
		if (method !== "GET") {
			const readOnly = await request(path, method, undefined, reader);
			expect(readOnly.status).toBe(403);
			expect(await readOnly.json()).toMatchObject({ error: { code: "scope_forbidden" } });
		}
	}
	for (const [path, method] of [
		["refresh-runs", "PUT"],
		["refresh-runs/latest", "POST"],
		["refresh-runs/latest", "HEAD"],
	] as const)
		expect((await request(path, method)).status).toBe(405);
	for (const [path, method] of [
		["refresh-runs/old/control", "GET"],
		["schedules/daily", "GET"],
		["schedules/daily", "POST"],
	])
		expect((await request(path ?? "", method)).status).toBe(404);
	expect((await request("refresh-runs?x=1")).status).toBe(400);
	expect(savedState()).toEqual(before);
	expect(await count()).toBe(upstream);
});

it("removes browser refresh and analysis projections behind Access without upstream calls or database writes", async () => {
	const jwt = process.env.GIRAFFE_JWT;
	const before = savedState();
	const upstream = await count();
	for (const [path, method] of [
		["refresh", "POST"],
		["factory/refresh", "POST"],
		["factory/runs", "POST"],
		["factory/runs/old/control", "POST"],
		["refresh/schedules/daily", "POST"],
		["refresh/schedules/weekly", "POST"],
		["factory/runs", "GET"],
		["factory/runs/latest?kind=daily", "GET"],
		["refresh/settings", "GET"],
		["refresh/times", "GET"],
		[`agent/accounts/${account}/analysis/reports`, "GET"],
		[`agent/accounts/${account}/analysis/daily`, "GET"],
		[`agent/accounts/${account}/reports/latest?type=github-daily`, "GET"],
		[`agent/accounts/${account}/records`, "POST"],
		[`agent/accounts/${account}/records`, "GET"],
		[`agent/accounts/${account}/jobs`, "GET"],
		[`agent/accounts/${account}/reports`, "GET"],
		[`agent/accounts/${account}/sources`, "GET"],
	] as const) {
		const url = `${base}/api/${path}`;
		const response = await fetch(url, {
			method,
			headers: {
				origin: "https://giraffe.dev.hexly.ai",
				...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
			},
		});
		expect(response.status, `${method} ${path}`).toBe(404);
		if (process.env.GIRAFFE_SUITE === "B")
			for (const assertion of [
				undefined,
				process.env.GIRAFFE_JWT_BAD_AUD,
				process.env.GIRAFFE_JWT_BAD_SIG,
			]) {
				const unauthenticated = await fetch(url, {
					method,
					headers: {
						origin: "https://giraffe.dev.hexly.ai",
						...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
					},
				});
				expect(unauthenticated.status).toBe(401);
			}
	}
	expect(savedState()).toEqual(before);
	expect(await count()).toBe(upstream);
});
