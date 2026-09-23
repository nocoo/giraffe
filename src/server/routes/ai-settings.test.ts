import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { Env } from "../env";
import { createApp } from "../index";
import { testAiConnection } from "../lib/ai-models";
import { loadAiConfig } from "../lib/ai-settings";

vi.mock("../lib/ai-models", () => ({ testAiConnection: vi.fn() }));

const key = "fake-ai-key-for-unit-tests";
const summary = {
	apiKey: key,
	model: "summary-test",
	baseURL: "https://models.example/v1",
	sdkType: "openai",
	authType: "apiKey",
};

async function setup() {
	const raw = sqliteFixture();
	await raw.prepare(readFileSync("migrations/0005_ai_settings.sql", "utf8")).run();
	const env = {
		DB: raw,
		FACTORY_QUEUE: {} as Queue,
		ASSETS: {} as Fetcher,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
	} as Env;
	const app = createApp();
	const request = (path = "", body?: unknown, bindings = env) =>
		app.request(
			`http://localhost/api/ai/settings${path}`,
			body === undefined
				? {}
				: {
						method: "POST",
						headers: { "content-type": "application/json", origin: "https://giraffe.dev.hexly.ai" },
						body: JSON.stringify(body),
					},
			bindings,
		);
	const remove = (kind: string) =>
		app.request(
			`http://localhost/api/ai/settings/${kind}`,
			{ method: "DELETE", headers: { origin: "https://giraffe.dev.hexly.ai" } },
			env,
		);
	return { raw, env, request, remove, app };
}

describe("AI settings routes", () => {
	beforeEach(() => {
		vi.mocked(testAiConnection).mockReset();
	});
	afterEach(() => {
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("starts empty and stores separate encrypted keys without returning credentials", async () => {
		const { request, raw, env } = await setup();
		expect(await loadAiConfig(env, "summary")).toBeNull();
		const empty = await request();
		expect(await empty.json()).toMatchObject({
			settings: [
				{ kind: "summary", hasApiKey: false, updatedAt: null },
				{
					kind: "judgment",
					hasApiKey: false,
					model: "jev-latest",
					baseURL: "https://api.typesafe.ai",
				},
			],
		});
		const saved = await request("/summary", summary);
		expect(saved.status).toBe(200);
		const payload = await saved.text();
		expect(payload).not.toContain(key);
		expect(JSON.parse(payload)).toMatchObject({
			kind: "summary",
			hasApiKey: true,
			model: "summary-test",
		});
		const stored = await raw.prepare("SELECT * FROM ai_settings WHERE kind='summary'").first();
		expect(JSON.stringify(stored)).not.toContain(key);
		expect(stored).toMatchObject({ key_version: 1 });
		expect(await loadAiConfig(env, "summary")).toEqual({ ...summary, kind: "summary" });
		expect((await request("/judgment", { apiKey: "fake-judgment-key" })).status).toBe(200);
		expect(await loadAiConfig(env, "judgment")).toMatchObject({
			apiKey: "fake-judgment-key",
			model: "jev-latest",
		});
		expect(await (await request()).json()).toMatchObject({
			settings: [{ hasApiKey: true }, { hasApiKey: true }],
		});
		expect(testAiConnection).not.toHaveBeenCalled();
	});

	it("retains an omitted key only for the same destination, and rotates encrypted keys", async () => {
		const { request, env, raw } = await setup();
		await request("/summary", summary);
		expect((await request("/summary", { model: "new-model", apiKey: "" })).status).toBe(200);
		expect(await loadAiConfig(env, "summary")).toMatchObject({ apiKey: key, model: "new-model" });
		for (const changed of [
			{ baseURL: "https://other.example/v1" },
			{ sdkType: "anthropic" },
			{ authType: "bearer" },
		]) {
			expect((await request("/summary", changed)).status).toBe(400);
			expect((await request("/summary/test", changed)).status).toBe(400);
		}
		expect(testAiConnection).not.toHaveBeenCalled();
		const rotated = {
			...env,
			TOKEN_ENCRYPTION_KEY_CURRENT: "2",
			TOKEN_ENCRYPTION_KEY_V2: "1".repeat(64),
		};
		expect(
			(
				await request(
					"/summary",
					{ apiKey: "replacement-key", baseURL: "https://other.example/v1/" },
					rotated,
				)
			).status,
		).toBe(200);
		expect(await loadAiConfig(rotated, "summary")).toMatchObject({
			apiKey: "replacement-key",
			baseURL: "https://other.example/v1",
		});
		expect(
			await raw.prepare("SELECT key_version FROM ai_settings WHERE kind='summary'").first(),
		).toEqual({ key_version: 2 });
	});

	it("tests a draft or stored configuration without saving or exposing failures", async () => {
		const { request, env } = await setup();
		vi.mocked(testAiConnection).mockResolvedValue({ model: "summary-test" });
		expect((await request("/summary/test", summary)).status).toBe(200);
		expect(testAiConnection).toHaveBeenCalledWith({ ...summary, kind: "summary" });
		expect(await loadAiConfig(env, "summary")).toBeNull();
		await request("/summary", summary);
		expect(await (await request("/summary/test", {})).json()).toMatchObject({ ok: true });
		vi.mocked(testAiConnection).mockRejectedValue(new Error(`upstream leaked ${key}`));
		const failed = await request("/summary/test", {});
		expect(failed.status).toBe(502);
		expect(await failed.text()).not.toContain(key);
		expect(await loadAiConfig(env, "summary")).toMatchObject({ apiKey: key });
	});

	it("rejects malformed values and unsafe destinations before sending any key", async () => {
		const { request } = await setup();
		for (const body of [
			null,
			[],
			"bad",
			{ ...summary, apiKey: 1 },
			{ ...summary, apiKey: null },
			{ ...summary, apiKey: "x\u0000y" },
			{ ...summary, apiKey: "x\ny" },
			{ ...summary, apiKey: "x".repeat(4097) },
			{ ...summary, model: "" },
			{ ...summary, model: "model\n" },
			{ ...summary, model: null },
			{ ...summary, baseURL: 1 },
			{ ...summary, baseURL: "x".repeat(2049) },
			{ ...summary, model: "x".repeat(161) },
			{ ...summary, sdkType: "custom" },
			{ ...summary, authType: "custom" },
		]) {
			expect((await request("/summary", body)).status).toBe(400);
		}
		for (const baseURL of [
			"invalid",
			"http://models.example/v1",
			"https://u:p@models.example",
			"https://models.example?key=secret",
			"https://models.example/#fragment",
			"https://localhost/v1",
			"https://127.0.0.1/v1",
			"https://10.0.0.1/v1",
			"https://192.168.1.1/v1",
			"https://172.16.0.1/v1",
			"https://[::1]/v1",
			"https://metadata.internal/v1",
		]) {
			expect((await request("/summary/test", { ...summary, baseURL })).status).toBe(400);
		}
		expect(
			(await request("/judgment", { apiKey: key, baseURL: "https://other.example" })).status,
		).toBe(400);
		expect((await request("/judgment", { apiKey: key, sdkType: "anthropic" })).status).toBe(400);
		expect((await request("/judgment", { apiKey: key, authType: "bearer" })).status).toBe(400);
		expect((await request("/unknown", summary)).status).toBe(404);
		expect((await request("/summary", { model: "model" })).status).toBe(400);
		expect(testAiConnection).not.toHaveBeenCalled();
	});

	it("fails safely when encryption configuration or encrypted data is invalid", async () => {
		const { request, env, raw } = await setup();
		expect(
			(await request("/summary", summary, { ...env, TOKEN_ENCRYPTION_KEY_CURRENT: "no" })).status,
		).toBe(500);
		expect(
			(await request("/summary", summary, { ...env, TOKEN_ENCRYPTION_KEY_CURRENT: "2" })).status,
		).toBe(500);
		await request("/summary", summary);
		await expect(
			loadAiConfig(
				{ ...env, TOKEN_ENCRYPTION_KEY_CURRENT: "2", TOKEN_ENCRYPTION_KEY_V1: "" } as Env,
				"summary",
			),
		).rejects.toMatchObject({ code: "encryption_misconfigured" });
		await raw.prepare("UPDATE ai_settings SET api_key_ciphertext='not-an-envelope'").run();
		await expect(loadAiConfig(env, "summary")).rejects.toMatchObject({
			code: "encryption_misconfigured",
		});
		expect((await request()).status).toBe(200);
	});

	it("disables a configured provider and clears its key without affecting the other provider", async () => {
		const { request, env, remove } = await setup();
		await request("/summary", summary);
		await request("/judgment", { apiKey: key });
		expect((await remove("summary")).status).toBe(204);
		expect(await loadAiConfig(env, "summary")).toBeNull();
		expect(await loadAiConfig(env, "judgment")).not.toBeNull();
		expect((await remove("summary")).status).toBe(204);
		expect((await remove("unknown")).status).toBe(404);
	});

	it("enforces authentication and origin before reading, saving, testing or deleting configurations", async () => {
		const { env, request, app } = await setup();
		await request("/summary", summary);
		const endpoints = [
			["", "GET"],
			["/summary", "POST"],
			["/summary", "DELETE"],
			["/summary/test", "POST"],
			["/judgment", "POST"],
			["/judgment", "DELETE"],
			["/judgment/test", "POST"],
		] as const;
		for (const [path, method] of endpoints) {
			const result = await app.request(
				`http://localhost/api/ai/settings${path}`,
				{ method, headers: { origin: "https://giraffe.hexly.ai" } },
				{ ...env, ENVIRONMENT: "production" },
			);
			expect(result.status).toBe(401);
			expect(await result.json()).toMatchObject({ error: { code: "access_unauthorized" } });
			if (method === "GET") continue;
			for (const origin of [undefined, "https://untrusted.example"]) {
				const headers = origin ? { origin } : {};
				const denied = await app.request(
					`http://localhost/api/ai/settings${path}`,
					{ method, headers },
					env,
				);
				expect(denied.status).toBe(403);
				expect(await denied.json()).toMatchObject({ error: { code: "origin_forbidden" } });
			}
		}
		expect(await loadAiConfig(env, "summary")).toMatchObject({ apiKey: key });
		expect(await loadAiConfig(env, "judgment")).toBeNull();
		expect(testAiConnection).not.toHaveBeenCalled();
	});

	it("allows only the declared methods through the real app router", async () => {
		const { env, app } = await setup();
		for (const [path, methods] of [
			["", ["POST", "DELETE", "HEAD", "PATCH"]],
			["/summary", ["GET", "HEAD", "PUT", "PATCH"]],
			["/judgment/test", ["GET", "HEAD", "DELETE", "PUT"]],
		] as const) {
			for (const method of methods) {
				const result = await app.request(
					`http://localhost/api/ai/settings${path}`,
					{ method, headers: { origin: "https://giraffe.dev.hexly.ai" } },
					env,
				);
				expect(result.status).toBe(405);
				if (method !== "HEAD")
					expect(await result.json()).toMatchObject({ error: { code: "method_not_allowed" } });
			}
		}
		expect(testAiConnection).not.toHaveBeenCalled();
	});

	it("accepts signed Access identity for both provider configurations with no credential response", async () => {
		const { env, app } = await setup();
		const pair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const unsigned = `${encode({ alg: "RS256", kid: "settings-test" })}.${encode({ iss: "http://127.0.0.1:17047", aud: "giraffe-settings", email: "settings@example.test", exp: Math.floor(Date.now() / 1000) + 60 })}`;
		const signature = await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			pair.privateKey,
			new TextEncoder().encode(unsigned),
		);
		const token = `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
		const signedEnv = {
			...env,
			ENVIRONMENT: "test",
			CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:17047",
			CF_ACCESS_AUD: "giraffe-settings",
			ACCESS_JWKS_URL: "http://127.0.0.1:17047/cdn-cgi/access/certs",
		};
		vi.stubGlobal("fetch", async (url: string) => {
			expect(String(url)).toBe(signedEnv.ACCESS_JWKS_URL);
			return Response.json({ keys: [{ ...jwk, kid: "settings-test" }] });
		});
		const headers = {
			origin: "https://giraffe.dev.hexly.ai",
			"content-type": "application/json",
			"Cf-Access-Jwt-Assertion": token,
		};
		vi.mocked(testAiConnection).mockResolvedValue({ model: "fixture" });
		for (const kind of ["summary", "judgment"] as const) {
			const result = await app.request(
				`http://localhost/api/ai/settings/${kind}`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(kind === "summary" ? summary : { apiKey: key }),
				},
				signedEnv,
			);
			expect(result.status).toBe(200);
			expect(await result.text()).not.toContain(key);
			const test = await app.request(
				`http://localhost/api/ai/settings/${kind}/test`,
				{ method: "POST", headers, body: "{}" },
				signedEnv,
			);
			expect(test.status).toBe(200);
			expect(await test.json()).toMatchObject({ ok: true });
		}
		const listed = await app.request("http://localhost/api/ai/settings", { headers }, signedEnv);
		expect(listed.status).toBe(200);
		expect(listed.headers.get("cache-control")).toBe("no-store");
		expect(await listed.text()).not.toContain(key);
		for (const kind of ["summary", "judgment"]) {
			expect(
				(
					await app.request(
						`http://localhost/api/ai/settings/${kind}`,
						{ method: "DELETE", headers },
						signedEnv,
					)
				).status,
			).toBe(204);
		}
		expect(await loadAiConfig(env, "summary")).toBeNull();
		expect(await loadAiConfig(env, "judgment")).toBeNull();
	});
});
