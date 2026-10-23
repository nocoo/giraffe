import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { factoryWindow } from "../../apps/web/src/lib/factory";
import { type FactoryRun, makeRun } from "../../apps/web/src/lib/factory-run";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const owner = `readiness-${account}`;
const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
const wrongScope = `giraffe_${randomBytes(32).toString("base64url")}`;
const started = "2026-10-21T21:00:00.000Z";
const finished = "2026-10-21T21:30:00.000Z";
const id = (kind: string) => `${account}-${kind}`;
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
		(item) => item.results,
	);
}
const marker = () =>
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
const request = (
	query = "?kind=daily",
	token: string | null = bearer,
	selected = account,
	method = "GET",
) =>
	fetch(`${base}/api/v1/accounts/${selected}/refresh-runs/latest${query}`, {
		method,
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});

beforeAll(() => {
	marker();
	const now = new Date().toISOString();
	const mint = (token: string, scopes: string[], suffix: string) =>
		`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(id(suffix))},${quote(account)},${quote(createHash("sha256").update(token).digest("hex"))},'readiness L2',${quote(JSON.stringify(scopes))},'local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`;
	const runRow = (kind: string, input: Partial<FactoryRun>) => {
		const run = {
			...makeRun(id(kind), account, owner, id(kind), "refresh", [], started),
			depth: "quick" as const,
			status: "completed" as const,
			finishedAt: finished,
			publishedAt: finished,
			...input,
		};
		run.steps = run.steps.slice(0, 1).map((step) => ({
			...step,
			status: run.status === "failed" ? "failed" : run.status === "running" ? "running" : "success",
			error: run.status === "failed" ? "snapshot_incomplete" : null,
		}));
		return `INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(${quote(run.id)},${quote(account)},${quote(run.requestKey)},${quote(run.status)},${quote(JSON.stringify(run))},${quote(started)},${quote(started)},${quote(started)});`;
	};
	seeded = true;
	rows(
		[
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(owner)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
			mint(bearer, ["app:read", "app:write"], "reader"),
			mint(wrongScope, ["agent:read"], "agent"),
			runRow("daily", {
				trigger: "daily",
				activityWindow: {
					since: "2026-10-20T21:00:00.000Z",
					until: started,
					first: false,
					gap: false,
				},
			}),
			runRow("weekly", { trigger: "weekly", depth: "deep", status: "running", finishedAt: null }),
			runRow("manual", { trigger: "manual", status: "failed" }),
			runRow("catalog", { mode: "catalog", status: "partial" }),
		].join("\n"),
	);
});
afterAll(() => {
	if (!seeded) return;
	marker();
	rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
});

it("R9 HTTP latest returns completed/partial publication, running ETA reason and safe failures without writes or upstream calls", async () => {
	const saved = () =>
		rows(
			`SELECT * FROM factory_runs WHERE account_id=${quote(account)} ORDER BY id; SELECT * FROM api_tokens WHERE account_id=${quote(account)} ORDER BY id;`,
		);
	const before = saved();
	const calls = await (await fetch("http://127.0.0.1:17046/_count")).text();
	for (const [kind, expected] of [
		[
			"daily",
			{
				status: "completed",
				publishedAt: finished,
				publishedAtReason: null,
				depth: "quick",
				expectedFinishAt: null,
				expectedFinishAtReason: "terminal",
				window: { until: started },
				counts: { total: 1, success: 1 },
			},
		],
		[
			"weekly",
			{
				status: "running",
				publishedAt: null,
				publishedAtReason: "in_progress",
				depth: "deep",
				expectedFinishAt: null,
				expectedFinishAtReason: "no_completed_history",
				window: factoryWindow(started),
			},
		],
		[
			"manual",
			{
				status: "failed",
				publishedAt: null,
				publishedAtReason: "failed",
				depth: "quick",
				lastError: "snapshot_incomplete",
				counts: { failed: 1 },
			},
		],
		[
			"catalog",
			{
				status: "partial",
				publishedAt: finished,
				publishedAtReason: null,
				depth: null,
				window: factoryWindow(started),
			},
		],
		["quick", { id: id("manual"), kind: "manual", window: factoryWindow(started) }],
		["deep", { id: id("weekly"), kind: "weekly", window: factoryWindow(started) }],
	] as const) {
		const response = await request(`?kind=${kind}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("vary")).toBe("Authorization");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await response.json()).toMatchObject({
			account_id: account,
			id: id(kind),
			kind,
			...expected,
		});
	}
	expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(calls);
	expect(saved()).toEqual(before);
});

it("R9 HTTP latest enforces strict queries, app-read, bearer/account isolation and GET-only methods", async () => {
	for (const query of ["", "?kind=other", "?kind=daily&kind=daily", "?kind=daily&x=1"]) {
		const response = await request(query);
		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("vary")).toBe("Authorization");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
	}
	for (const [token, status] of [
		[null, 401],
		["invalid", 401],
		[wrongScope, 403],
	] as const) {
		const response = await request("?kind=daily", token);
		expect(response.status).toBe(status);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("vary")).toBe("Authorization");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	}
	expect((await request("?kind=daily", bearer, "z".repeat(21))).status).toBe(403);
	for (const method of ["POST", "HEAD"])
		expect((await request("?kind=daily", bearer, account, method)).status).toBe(405);
});

it("R9 HTTP browser latest uses the Access-protected active account and returns 404 for missing kinds", async () => {
	marker();
	const prior = rows("SELECT id FROM accounts WHERE is_active=1")[0]?.id;
	rows(
		`UPDATE accounts SET is_active=0 WHERE is_active=1; UPDATE accounts SET is_active=1 WHERE id=${quote(account)};`,
	);
	const jwt = process.env.GIRAFFE_JWT;
	const browser = (query: string) =>
		fetch(`${base}/api/factory/runs/latest${query}`, {
			headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
		});
	try {
		const response = await browser("?kind=daily");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({
			account_id: account,
			id: id("daily"),
			publishedAt: finished,
		});
		expect((await browser("?kind=daily&x=1")).status).toBe(400);
		rows(`DELETE FROM factory_runs WHERE id=${quote(id("weekly"))};`);
		for (const response of [await browser("?kind=weekly"), await request("?kind=weekly")]) {
			expect(response.status).toBe(404);
			if (response.url.includes("/api/v1/")) {
				expect(response.headers.get("cache-control")).toBe("private, no-store");
				expect(response.headers.get("vary")).toBe("Authorization");
				expect(response.headers.get("referrer-policy")).toBe("no-referrer");
			}
			expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
		}
	} finally {
		marker();
		rows(
			`UPDATE accounts SET is_active=0 WHERE id=${quote(account)};${typeof prior === "string" ? `UPDATE accounts SET is_active=1 WHERE id=${quote(prior)};` : ""}`,
		);
	}
});
