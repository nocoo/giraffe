import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { dailyAt, dailyPayload } from "../../lib/__tests__/github-daily-fixture";
import type { ApiScope } from "../../lib/api-access";
import type { Env } from "../env";
import { createApp } from "../index";
import { createApiToken } from "../lib/api-tokens";
import { createDb } from "../lib/db/d1";
import { ApiError } from "../lib/errors";
import * as reportLatest from "../lib/report-latest";

async function fixture(active = true) {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','owner','fake','fake',?,?,?),('b','other','fake','fake',0,?,?)",
		)
		.bind(Number(active), dailyAt, dailyAt, dailyAt, dailyAt)
		.run();
	const mint = (scopes: ApiScope[]) =>
		createApiToken(createDb(raw), {
			accountId: "a",
			label: "reports",
			scopes,
			expiresInDays: 1,
			creator: "fixture@local",
		});
	const token = await mint(["agent:read", "agent:write"]);
	const app = createApp();
	const env = {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as unknown as Env;
	const call = (
		suffix: string,
		browser = false,
		method = "GET",
		body?: unknown,
		headers: Record<string, string> = {},
		account = "a",
	) =>
		app.request(
			`http://localhost${browser ? `/api/agent/accounts/${account}` : `/api/v1/accounts/${account}/agent`}${suffix}`,
			{
				method,
				headers: {
					"content-type": "application/json",
					...(browser
						? { origin: "http://localhost" }
						: { authorization: `Bearer ${token.token}` }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);
	return { raw, app, env, mint, token, call };
}
const body = () => ({ type: "github-daily", status: "completed", payload: dailyPayload() });

it.each([false])(
	"R8 daily POST returns 201/200, latest preserves machine storage, raw strict JSON rejects before transformation (browser=%state)",
	async (browser) => {
		const state = await fixture();
		const created = await state.call("/reports", browser, "POST", body());
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			item: { id: "github-daily-2026-10-22", revision: 1 },
		});
		const replaced = await state.call("/reports", browser, "POST", body());
		expect(replaced.status).toBe(200);
		expect(await replaced.json()).toMatchObject({ item: { revision: 2 } });
		const latest = await state.call("/reports/latest?type=github-daily", browser);
		expect(latest.status).toBe(200);
		const payload = JSON.parse(JSON.stringify(dailyPayload()));
		Object.defineProperty(payload, "__proto__", {
			value: { opaque: "x".repeat(66000) },
			enumerable: true,
		});
		for (const method of ["POST", "PATCH"]) {
			const response = await state.call(
				`/reports${method === "PATCH" ? "/github-daily-2026-10-22" : ""}`,
				browser,
				method,
				{
					...(method === "PATCH" ? { revision: 2 } : { type: "github-daily", status: "completed" }),
					payload,
				},
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
		}
	},
);

it.each([false])(
	"R8 strong full-body ETag supports 304 forms, empty latest and required headers without GET writes (browser=%state)",
	async (browser) => {
		const state = await fixture();
		const path = "/reports/latest?type=github-daily";
		const empty = await state.call(path, browser);
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({ account_id: "a", item: null, invalidCount: 0 });
		await state.call("/reports", false, "POST", body());
		const first = await state.call(path, browser);
		const tag = first.headers.get("etag");
		expect(tag).toMatch(/^"[a-f0-9]{64}"$/);
		const rows = async () => [
			await state.raw.prepare("SELECT * FROM agent_resources ORDER BY id").all(),
			await state.raw.prepare("SELECT * FROM api_tokens ORDER BY id").all(),
		];
		const before = await rows();
		const network = vi.spyOn(globalThis, "fetch");
		try {
			for (const match of [tag ?? "", `W/${tag}`, `"other", ${tag}`, "*"]) {
				const response = await state.call(path, browser, "GET", undefined, {
					"if-none-match": match,
				});
				expect(response.status).toBe(304);
				expect(await response.text()).toBe("");
				expect(response.headers.get("etag")).toBe(tag);
				expect(response.headers.get("cache-control")).toBe("private, no-store");
				expect(response.headers.get("referrer-policy")).toBe("no-referrer");
				expect(response.headers.get("vary")).toBe(
					browser ? "Cookie, Cf-Access-Jwt-Assertion" : "Authorization",
				);
			}
			for (const match of ['"stale"', "malformed"])
				expect(
					(await state.call(path, browser, "GET", undefined, { "if-none-match": match })).status,
				).toBe(200);
			expect(await rows()).toEqual(before);
			expect(network).not.toHaveBeenCalled();
		} finally {
			network.mockRestore();
		}
		await state.raw
			.prepare(
				"INSERT INTO agent_resources(account_id,collection,id,type,status,payload,created_at,updated_at) VALUES('a','reports','legacy','github-daily','completed',?,?,?)",
			)
			.bind(JSON.stringify(dailyPayload()), dailyAt, dailyAt)
			.run();
		const changed = await state.call(path, browser, "GET", undefined, {
			"if-none-match": tag ?? "",
		});
		expect(changed.status).toBe(200);
		expect(changed.headers.get("etag")).not.toBe(tag);
		expect(await changed.json()).toMatchObject({ invalidCount: 1, item: { revision: 1 } });
	},
);

it.each([
	{ browser: false, status: 400, code: "validation_failed" },
	{ browser: false, status: 404, code: "not_found" },
	{ browser: false, status: 409, code: "snapshot_missing" },
])(
	"keeps private latest-report reader error headers for $status (browser=$browser)",
	async ({ browser, status, code }) => {
		const state = await fixture();
		const reader = vi.spyOn(reportLatest, "readLatestReport");
		if (status !== 400)
			reader.mockRejectedValueOnce(new ApiError(status, code, "Report unavailable"));
		try {
			const response = await state.call(
				`/reports/latest?type=${status === 400 ? "" : "github-daily"}`,
				browser,
				"GET",
				undefined,
				{ "if-none-match": "*" },
			);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ error: { code } });
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			expect(response.headers.get("referrer-policy")).toBe("no-referrer");
			expect(response.headers.get("vary")).toBe(
				browser ? "Cookie, Cf-Access-Jwt-Assertion" : "Authorization",
			);
			expect(response.headers.get("etag")).toBeNull();
		} finally {
			reader.mockRestore();
		}
	},
);

it.each([false])(
	"keeps private latest-report generic not-found headers (browser=%s)",
	async (browser) => {
		const state = await fixture();
		const response = await state.call("/reports/latest", browser, "GET", undefined, {
			"if-none-match": "*",
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("vary")).toBe(
			browser ? "Cookie, Cf-Access-Jwt-Assertion" : "Authorization",
		);
		expect(response.headers.get("etag")).toBeNull();
	},
);

it("R8 validates type/query/auth/account before conditional GET and keeps history GET-only", async () => {
	const state = await fixture();
	for (const browser of [false]) {
		for (const query of ["type=", "type=bad/type", "type=custom&type=other", "type=custom&limit=1"])
			expect(
				(
					await state.call(`/reports/latest?${query}`, browser, "GET", undefined, {
						"if-none-match": "*",
					})
				).status,
			).toBe(400);
		expect(
			(await state.call("/reports/latest?type=custom", browser, "GET", undefined, {}, "b")).status,
		).toBe(browser ? 409 : 403);
		expect((await state.call("/reports/latest?type=custom", browser, "HEAD")).status).toBe(405);
	}
	for (const scopes of [["app:read"], ["observations:read"], ["agent:write"]] as ApiScope[][]) {
		const token = await state.mint(scopes);
		expect(
			(
				await state.call("/reports/latest?type=custom", false, "GET", undefined, {
					authorization: `Bearer ${token.token}`,
					"if-none-match": "*",
				})
			).status,
		).toBe(403);
	}
	const reader = await state.mint(["agent:read"]);
	expect(
		(
			await state.call("/reports/latest?type=custom", false, "GET", undefined, {
				authorization: `Bearer ${reader.token}`,
			})
		).status,
	).toBe(200);
	expect(
		(
			await state.call("/reports/latest?type=custom", false, "GET", undefined, {
				authorization: "Bearer invalid",
				"if-none-match": "*",
			})
		).status,
	).toBe(401);
	expect(
		(
			await state.app.request(
				"http://localhost/api/agent/accounts/a/reports/latest?type=custom",
				{ headers: { "if-none-match": "*" } },
				{ ...state.env, ENVIRONMENT: "production" },
			)
		).status,
	).toBe(401);
});

it.each([false])(
	"R8 generic reports and literal ID latest preserve CRUD and pagination (browser=%state)",
	async (browser) => {
		const state = await fixture();
		const generic = {
			id: "latest",
			type: "ordinary",
			status: "pending",
			payload: { generatedAt: dailyAt, opaque: true },
		};
		expect((await state.call("/reports", browser, "POST", generic)).status).toBe(201);
		expect((await state.call("/reports", browser, "POST", generic)).status).toBe(409);
		expect(await (await state.call("/reports/latest", browser)).json()).toMatchObject({
			item: { id: "latest", type: "ordinary" },
		});
		expect(await (await state.call("/reports/latest?type=ordinary", browser)).json()).toMatchObject(
			{ item: { id: "latest", type: "ordinary" } },
		);
		expect(
			await (await state.call("/reports?limit=1&type=ordinary", browser)).json(),
		).toMatchObject({ items: [{ id: "latest" }], nextCursor: null });
		expect(
			(await state.call("/reports/latest", browser, "PATCH", { revision: 1, status: "failed" }))
				.status,
		).toBe(200);
		expect((await state.call("/reports/latest?revision=2", browser, "DELETE")).status).toBe(204);
		expect((await state.call("/reports/latest", browser)).status).toBe(404);
		expect(
			(
				await state.call("/records", browser, "POST", {
					type: "github-daily",
					status: "pending",
					payload: {},
				})
			).status,
		).toBe(201);
	},
);
