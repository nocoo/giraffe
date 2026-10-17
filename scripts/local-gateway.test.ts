import { describe, expect, it, vi } from "vitest";
import { createLocalGateway } from "./local-gateway";

const origin = "https://giraffe.dev.hexly.ai";
function setup() {
	const upstream = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => Response.json({ ok: true }));
	const token = vi.fn(async () => "fake-access-token");
	const gateway = createLocalGateway({ fetch: upstream, token });
	const request = (path = "/api/repos", init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set("origin", origin);
		headers.set("x-giraffe-local-instance", gateway.descriptor().instanceId);
		return new Request(`${origin}${path}`, { ...init, headers });
	};
	const select = (mode: string) =>
		gateway.handle(
			request("/api/__local/environment", {
				method: "POST",
				headers: { "x-giraffe-local-csrf": gateway.descriptor().csrfToken },
				body: JSON.stringify({ mode }),
			}),
		);
	return { gateway, upstream, token, request, select };
}

describe("local environment gateway", () => {
	it("starts local, forwards body/query and strips credentials in both directions", async () => {
		const { gateway, request, upstream, token } = setup();
		expect(gateway.descriptor().mode).toBe("local");
		upstream.mockResolvedValueOnce(
			Response.json({ saved: true }, { headers: { "set-cookie": "secret=redacted" } }),
		);
		const response = await gateway.handle(
			request("/api/repos/a/b/star?scope=all", {
				method: "POST",
				headers: {
					cookie: "browser-secret",
					authorization: "Bearer browser-secret",
					"cf-access-jwt-assertion": "spoofed",
					"content-type": "application/json",
				},
				body: '{"starred":true}',
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const [url, init] = upstream.mock.calls[0] ?? [];
		expect(url).toBe("http://127.0.0.1:37045/api/repos/a/b/star?scope=all");
		expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"starred":true}');
		const headers = new Headers(init?.headers);
		for (const key of [
			"cookie",
			"authorization",
			"cf-access-jwt-assertion",
			"x-giraffe-local-instance",
		])
			expect(headers.has(key)).toBe(false);
		expect(headers.get("origin")).toBe(origin);
		expect(token).not.toHaveBeenCalled();
	});

	it("rejects foreign hosts, cross-site requests and unsafe origins before any upstream call", async () => {
		const { gateway, upstream, token, request } = setup();
		for (const req of [
			new Request("https://evil.example/api/repos"),
			new Request(`${origin}/api/repos`, { headers: { origin: "https://evil.example" } }),
			request("/api/repos", { headers: { "sec-fetch-site": "cross-site" } }),
			new Request(`${origin}/api/refresh`, { method: "POST" }),
		])
			expect((await gateway.handle(req)).status).toBe(403);
		expect(upstream).not.toHaveBeenCalled();
		expect(token).not.toHaveBeenCalled();
	});

	it("requires instance and CSRF, rejects invalid selections and reserves local routes", async () => {
		const { gateway, request, upstream, select } = setup();
		expect((await gateway.handle(new Request(`${origin}/api/repos`))).status).toBe(409);
		expect((await gateway.handle(request("/api/__local/environment"))).status).toBe(405);
		expect((await gateway.handle(request("/api/__local/other"))).status).toBe(404);
		expect(
			(await gateway.handle(request("/api/__local/environment", { method: "POST" }))).status,
		).toBe(403);
		for (const mode of ["https://evil.example", "e2e", ""])
			expect((await select(mode)).status).toBe(400);
		expect(
			(
				await gateway.handle(
					request("/api/__local/environment", {
						method: "POST",
						headers: { "x-giraffe-local-csrf": gateway.descriptor().csrfToken },
						body: "{",
					}),
				)
			).status,
		).toBe(400);
		expect(upstream).not.toHaveBeenCalled();
	});

	it("checks real-session availability before accepting Prod and never returns credentials", async () => {
		const { gateway, select, token, upstream, request } = setup();
		const old = gateway.descriptor();
		const accepted = await select("prod");
		expect(accepted.status).toBe(200);
		expect(await accepted.text()).not.toContain("fake-access-token");
		expect(gateway.descriptor().mode).toBe("prod");
		expect(gateway.descriptor().instanceId).not.toBe(old.instanceId);
		expect(upstream.mock.calls[0]?.[0]).toBe("https://giraffe.hexly.ai/api/me");
		await gateway.handle(request("/api/ci?scope=all"));
		expect(upstream.mock.lastCall?.[0]).toBe("https://giraffe.hexly.ai/api/ci?scope=all");
		const headers = new Headers(upstream.mock.lastCall?.[1]?.headers);
		expect(headers.get("cookie")).toBe("CF_Authorization=fake-access-token");
		expect(token).toHaveBeenCalled();
	});

	it("blocks every Prod mutation and machine API without credentials or upstream effects", async () => {
		const { gateway, select, request, upstream, token } = setup();
		await select("prod");
		upstream.mockClear();
		token.mockClear();
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]) {
			const response = await gateway.handle(request("/api/factory/runs", { method }));
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ error: { code: "local_read_only" } });
		}
		expect((await gateway.handle(request("/api/v1/accounts"))).status).toBe(403);
		expect(upstream).not.toHaveBeenCalled();
		expect(token).not.toHaveBeenCalled();
		expect((await select("local")).status).toBe(200);
		expect(gateway.descriptor().mode).toBe("local");
	});

	it("rejects stale tabs and keeps already accepted local requests on their captured target", async () => {
		const { gateway, request, select, upstream } = setup();
		const old = request();
		let finish!: (response: Response) => void;
		upstream.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = gateway.handle(request("/api/refresh", { method: "POST" }));
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		await select("prod");
		finish(Response.json({ saved: true }));
		expect((await pending).status).toBe(200);
		expect(upstream.mock.calls[0]?.[0]).toBe("http://127.0.0.1:37045/api/refresh");
		upstream.mockClear();
		expect((await gateway.handle(old)).status).toBe(409);
		expect(upstream).not.toHaveBeenCalled();
	});

	it("serializes switches and leaves the current environment intact on failed Prod login", async () => {
		const { gateway, select, token, upstream } = setup();
		const original = gateway.descriptor();
		token.mockRejectedValueOnce(new Error("private credential detail"));
		const failed = await select("prod");
		expect(failed.status).toBe(401);
		expect(await failed.text()).not.toContain("private credential detail");
		expect(gateway.descriptor()).toEqual(original);
		expect(upstream).not.toHaveBeenCalled();
		let finish!: (response: Response) => void;
		upstream.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = select("prod");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		expect((await select("local")).status).toBe(409);
		finish(Response.json({ ok: true }));
		expect((await pending).status).toBe(200);
	});

	it.each([
		() => new Response(null, { status: 302, headers: { location: "https://login.test" } }),
		() => new Response("secret login html", { headers: { "content-type": "text/html" } }),
		() => new Response("private denial", { status: 403 }),
		() => new Response("private denial", { status: 401 }),
	])(
		"converts Prod auth failures to actionable errors without redirects or secret bodies",
		async (reply) => {
			const { gateway, select, upstream } = setup();
			upstream.mockResolvedValueOnce(reply());
			const response = await select("prod");
			expect(response.status).toBe(401);
			expect(response.headers.has("location")).toBe(false);
			expect(await response.text()).toContain("bun run login:prod");
			expect(gateway.descriptor().mode).toBe("local");
		},
	);

	it("does not fall back on upstream failure and preserves HEAD/204 semantics", async () => {
		const { gateway, request, upstream, select } = setup();
		await select("prod");
		upstream.mockRejectedValueOnce(new Error("private upstream data"));
		const failed = await gateway.handle(request());
		expect(failed.status).toBe(502);
		expect(await failed.text()).not.toContain("private upstream data");
		expect(gateway.descriptor().mode).toBe("prod");
		upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
		expect((await gateway.handle(request())).status).toBe(204);
		upstream.mockResolvedValueOnce(new Response(null, { status: 200 }));
		expect((await gateway.handle(request("/api/repos", { method: "HEAD" }))).status).toBe(200);
		expect(upstream.mock.lastCall?.[1]?.body).toBeUndefined();
	});
});
