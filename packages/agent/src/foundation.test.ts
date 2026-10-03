import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, GiraffeClient, retryableApiError } from "./client.ts";
import {
	type Credential,
	configSchema,
	credentialSchema,
	readConfig,
	readCredential,
	serviceUrl,
	writePrivateJson,
} from "./config.ts";
import { judgmentSchema } from "./contracts.ts";
import { login } from "./login.ts";

const directories: string[] = [];
const temporary = () => {
	const dir = mkdtempSync(join(tmpdir(), "giraffe-agent-test-"));
	directories.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const credential: Credential = {
	baseUrl: "https://example.test",
	account_id: "test-account",
	token: "test-credential",
	expires_at: "2099-01-01T00:00:00.000Z",
	scopes: ["observations:read", "agent:read", "agent:write"],
};
const config = {
	providers: {
		models: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:7024/v1",
			apiKey: "test-model-key",
		},
		decision: {
			api: "typesafe-systemone",
			baseUrl: "http://127.0.0.1:19823",
			apiKey: "test-decision-key",
		},
	},
	roles: {
		orchestrator: { provider: "models", model: "planner" },
		executor: { provider: "models", model: "worker" },
		decision: { provider: "decision", model: "jev-latest" },
	},
};
const item = {
	id: "test",
	account_id: credential.account_id,
	type: "github-analysis",
	repository: null,
	status: "complete",
	source_version: "version",
	payload: {},
	revision: 1,
	created_at: "2026-10-02T00:00:00.000Z",
	updated_at: "2026-10-02T00:00:00.000Z",
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const transport = (responses: Response[]) =>
	vi.fn<typeof fetch>(async () => {
		const response = responses.shift();
		if (!response) throw new Error("No response queued");
		return response;
	});

describe("global configuration", () => {
	it("validates URLs, roles and safe token limits without leaking secrets", () => {
		expect(configSchema.parse(config).roles.executor.maxTokens).toBe(4096);
		for (const url of [
			"http://remote.test",
			"file:///tmp/key",
			"https://user:key@host.test",
			"https://host.test?a=1",
			"https://host.test#secret",
		])
			expect(serviceUrl.safeParse(url).success).toBe(false);
		for (const url of ["https://example.test", "http://localhost:5000", "http://127.0.0.1:5000"])
			expect(serviceUrl.safeParse(url).success).toBe(true);
		expect(
			configSchema.safeParse({
				...config,
				roles: { ...config.roles, decision: config.roles.executor },
			}).success,
		).toBe(false);
		expect(
			configSchema.safeParse({
				...config,
				roles: {
					...config.roles,
					executor: { provider: "absent", model: "worker" },
				},
			}).success,
		).toBe(false);
		expect(
			configSchema.safeParse({
				...config,
				roles: {
					...config.roles,
					executor: {
						...config.roles.executor,
						maxTokens: 32000,
						contextWindow: 8192,
					},
				},
			}).success,
		).toBe(false);
		const dir = temporary();
		expect(() => readConfig(dir)).toThrow(/Cannot read/);
		writePrivateJson(join(dir, "config.json"), config);
		expect(readConfig(dir).roles.orchestrator.model).toBe("planner");
		writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "secret-not-in-error" }));
		expect(() => readConfig(dir)).toThrow(/Invalid Giraffe configuration/);
		try {
			readConfig(dir);
		} catch (error) {
			expect(String(error)).not.toContain("secret-not-in-error");
		}
	});
	it("persists private credentials independently from model config", () => {
		const dir = join(temporary(), "config");
		writePrivateJson(join(dir, "config.json"), config);
		expect(() => readCredential(dir)).toThrow(/login/);
		writePrivateJson(join(dir, "credentials.json"), credential);
		expect(readCredential(dir)).toEqual(credential);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
		expect(readConfig(dir).roles.executor.model).toBe("worker");
		writePrivateJson(join(dir, "credentials.json"), {
			...credential,
			expires_at: "2020-01-01T00:00:00.000Z",
		});
		expect(() => readCredential(dir)).toThrow(/login/);
		expect(credentialSchema.safeParse({ ...credential, token: "" }).success).toBe(false);
	});
});

it("validates analysis scope and decision probability distributions", () => {
	const decision = {
		model: "jev",
		choice: "review",
		confidence: 0.5,
		probabilities: { review: 0.7, urgent: 0.1, routine: 0.1, unknown: 0.1 },
	};
	expect(judgmentSchema.safeParse(decision).success).toBe(true);
	expect(judgmentSchema.safeParse({ ...decision, choice: "urgent" }).success).toBe(false);
	expect(
		judgmentSchema.safeParse({
			...decision,
			probabilities: { review: 0.8, urgent: 0.1, routine: 0.1, unknown: 0.1 },
		}).success,
	).toBe(false);
});

describe("authenticated client", () => {
	it("reads paginated resources and sends bearer only to its configured service", async () => {
		const send = transport([
			json({
				account_id: credential.account_id,
				login: "owner",
				token: { id: "token", scopes: [], expires_at: credential.expires_at },
			}),
			json({
				account_id: credential.account_id,
				items: [item],
				nextCursor: "test",
			}),
			json({
				account_id: credential.account_id,
				items: [{ ...item, id: "test2" }],
				nextCursor: null,
			}),
		]);
		const client = new GiraffeClient(credential, send);
		expect((await client.me()).login).toBe("owner");
		expect(await client.list("reports", { type: "github-analysis" })).toHaveLength(2);
		expect(send.mock.calls[2]?.[0]).toContain("cursor=test");
		expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: `Bearer ${credential.token}`,
		});
		expect(send.mock.calls[0]?.[1]?.redirect).toBe("error");
	});
	it("rejects account mismatches, repeated cursors and sanitized API failures", async () => {
		const send = transport([
			json({ account_id: "other", items: [], nextCursor: null }),
			json({
				account_id: credential.account_id,
				items: [],
				nextCursor: "same",
			}),
			json({
				account_id: credential.account_id,
				items: [],
				nextCursor: "same",
			}),
			json({ error: { code: "scope_missing", message: "sensitive-message" } }, 403),
			new Response("not-json", { status: 500 }),
		]);
		const client = new GiraffeClient(credential, send);
		await expect(client.list("reports")).rejects.toThrow("account_mismatch");
		await expect(client.list("reports")).rejects.toThrow("pagination_loop");
		await expect(client.get("reports", "test")).rejects.toThrow("scope_missing");
		await expect(client.get("reports", "test")).rejects.toThrow("request_failed");
		await expect(client.get("reports", "test")).rejects.toThrow("connection_failed");
	});
	it("performs CRUD with revisions and reconciles duplicate creates", async () => {
		const send = transport([
			json({ account_id: credential.account_id, item }, 201),
			json({ error: { code: "resource_exists" } }, 409),
			json({ account_id: credential.account_id, item }),
			json({
				account_id: credential.account_id,
				item: { ...item, revision: 2 },
			}),
			new Response(null, { status: 204 }),
			json({ error: { code: "not_found" } }, 404),
			json({ error: { code: "revision_conflict" } }, 409),
		]);
		const client = new GiraffeClient(credential, send);
		expect(await client.create("reports", item)).toEqual(item);
		expect(await client.create("reports", item)).toEqual(item);
		expect((await client.update("reports", item, { status: "completed" })).revision).toBe(2);
		expect(JSON.parse(String(send.mock.calls[3]?.[1]?.body))).toMatchObject({
			revision: 1,
			status: "completed",
		});
		await client.remove("reports", item);
		expect(send.mock.calls[4]?.[0]).toContain("revision=1");
		expect(await client.get("reports", "missing")).toBeNull();
		await expect(client.update("reports", item, {})).rejects.toBeInstanceOf(ApiError);
	});

	it("propagates cancellation through publication and duplicate reconciliation", async () => {
		const controller = new AbortController();
		const send = transport([
			json({ error: { code: "resource_exists" } }, 409),
			json({ account_id: credential.account_id, item }),
		]);
		const client = new GiraffeClient(credential, send);
		await client.create("reports", item, controller.signal);
		controller.abort();
		expect(send.mock.calls.every((call) => call[1]?.signal?.aborted)).toBe(true);
	});
	it("validates observation envelopes without deriving successful zero from absence", async () => {
		const envelope = {
			account_id: credential.account_id,
			data: { issues: [] },
			sourceVersion: "v1",
			fetchedAt: null,
			freshness: null,
			coverage: null,
			truncated: false,
			unavailable: true,
			source: { kind: "snapshot", resource: "issues", publicationId: null },
			selection: { scope: "all", statisticsFilter: false },
		};
		const client = new GiraffeClient(credential, transport([json(envelope)]));
		expect((await client.observation("issues", new AbortController().signal)).unavailable).toBe(
			true,
		);
	});

	it("refuses excessive pagination and conflicting resource identities", async () => {
		let page = 0;
		const client = new GiraffeClient(
			credential,
			vi.fn<typeof fetch>(async () =>
				json({
					account_id: credential.account_id,
					items: [],
					nextCursor: String(page++),
				}),
			),
		);
		await expect(client.list("reports")).rejects.toThrow("pagination_limit");
		const send = transport([
			json({ error: { code: "resource_exists" } }, 409),
			json({
				account_id: credential.account_id,
				item: { ...item, source_version: "different" },
			}),
			json({ error: { code: "unexpected_error" } }, 500),
		]);
		const other = new GiraffeClient(credential, send);
		await expect(other.create("reports", item)).rejects.toThrow("resource_exists");
		await expect(other.create("reports", item)).rejects.toThrow("unexpected_error");
		const invalidCode = new GiraffeClient(
			credential,
			transport([json({ error: { code: "secret invalid code" } }, 400)]),
		);
		await expect(invalidCode.get("records", "test")).rejects.toThrow("request_failed");
		await expect(
			other.create("reports", {
				...item,
				payload: { huge: "x".repeat(65536) },
			}),
		).rejects.toThrow("payload_too_large");
	});
});

describe("browser login", () => {
	it("exchanges a one-time PKCE code through a real loopback callback", async () => {
		const dir = temporary();
		let challenge = "";
		let callback = "";
		const send = vi.fn<typeof fetch>(async (_url, init) => {
			const data = JSON.parse(String(init?.body));
			expect(data.code).toBe("one-time-code");
			expect(data.redirect_uri).toBe(callback);
			expect(createHash("sha256").update(data.code_verifier).digest("base64url")).toBe(challenge);
			return json(credential);
		});
		const result = await login(credential.baseUrl, {
			directory: dir,
			transport: send,
			browser: async (address) => {
				const url = new URL(address);
				expect(url.pathname).toBe("/authorize");
				expect(url.searchParams.has("callback")).toBe(false);
				challenge = url.searchParams.get("code_challenge") ?? "";
				callback = url.searchParams.get("redirect_uri") ?? "";
				const responseUrl = new URL(callback);
				responseUrl.searchParams.set("code", "one-time-code");
				responseUrl.searchParams.set("state", url.searchParams.get("state") ?? "");
				expect((await fetch(responseUrl)).status).toBe(200);
			},
		});
		expect(result.accountId).toBe(credential.account_id);
		expect(readCredential(dir).token).toBe(credential.token);
		expect(readFileSync(join(dir, "credentials.json"), "utf8")).not.toContain("one-time-code");
	});
	it("does not persist credentials after callback or exchange failure", async () => {
		const dir = temporary();
		await expect(
			login(credential.baseUrl, {
				directory: dir,
				timeoutMs: 20,
				browser: async () => {},
			}),
		).rejects.toThrow(/not completed/);
		await expect(
			login(credential.baseUrl, {
				directory: dir,
				transport: transport([json({}, 401)]),
				browser: async (address) => {
					const url = new URL(address);
					const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
					callback.searchParams.set("code", "test-code");
					callback.searchParams.set("state", url.searchParams.get("state") ?? "");
					await fetch(callback);
				},
			}),
		).rejects.toThrow(/401/);
		expect(() => readCredential(dir)).toThrow(/login/);
	});
});

it("distinguishes recoverable service failures from terminal bad requests", () => {
	for (const status of [0, 401, 403, 408, 429, 500, 503])
		expect(retryableApiError(new ApiError(status, "unavailable"))).toBe(true);
	expect(retryableApiError(new ApiError(409, "revision_conflict"))).toBe(true);
	expect(retryableApiError(new ApiError(409, "resource_exists"))).toBe(false);
	expect(retryableApiError(new ApiError(400, "validation_failed"))).toBe(false);
	expect(retryableApiError(new Error("model failed"))).toBe(false);
});
