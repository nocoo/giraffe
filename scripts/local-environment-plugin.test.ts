import { createServer, request as httpRequest, type Server } from "node:http";
import type { MinimalPluginContextWithoutEnvironment } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { localEnvironmentPlugin, localMiddleware } from "./local-environment-plugin";
import { createLocalGateway } from "./local-gateway";

let server: Server | undefined;
afterEach(async () => {
	if (!server) return;
	server.closeAllConnections();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

async function fixture() {
	const upstream = vi.fn<typeof fetch>((async () =>
		Response.json({ repos: [] })) as unknown as typeof fetch);
	const token = vi.fn(async () => "fake-token");
	const gateway = createLocalGateway({ fetch: upstream, token });
	const middleware = localMiddleware(gateway);
	server = createServer((req, res) => middleware(req, res, () => res.end("vite-assets")));
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local listener");
	const send = (path: string, method = "GET", body?: string, host = "giraffe.dev.hexly.ai") =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = httpRequest(
				{
					hostname: "127.0.0.1",
					port: address.port,
					path,
					method,
					headers: {
						host,
						origin: `https://${host}`,
						"x-giraffe-local-instance": gateway.descriptor().instanceId,
						"x-giraffe-local-csrf": gateway.descriptor().csrfToken,
					},
				},
				(res) => {
					let text = "";
					res.on("data", (chunk) => {
						text += chunk;
					});
					res.on("error", reject);
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	return { send, upstream, token, gateway };
}

it("mounts only on the dev server and injects an instance without credentials", () => {
	const plugin = localEnvironmentPlugin();
	expect(plugin.apply).toBe("serve");
	if (typeof plugin.transformIndexHtml !== "function") throw new Error("Missing bootstrap");
	const tags = plugin.transformIndexHtml.call({} as MinimalPluginContextWithoutEnvironment, "", {
		path: "/",
		filename: "index.html",
	});
	expect(JSON.stringify(tags)).toContain("window.__GIRAFFE_LOCAL__");
	expect(JSON.stringify(tags)).toContain('\\"mode\\":\\"local\\"');
	expect(JSON.stringify(tags)).not.toContain("CF_Authorization");
});

it("uses the real HTTP adapter for assets, JSON body/query and Prod read-only rejection", async () => {
	const { send, upstream } = await fixture();
	expect((await send("/factory")).body).toBe("vite-assets");
	expect((await send("/api/repos?scope=all")).status).toBe(200);
	expect(upstream.mock.lastCall?.[0]).toBe("http://127.0.0.1:37045/api/repos?scope=all");
	expect((await send("/api/__local/environment", "POST", '{"mode":"prod"}')).status).toBe(200);
	upstream.mockClear();
	expect((await send("/api/refresh", "POST", "{}")).status).toBe(403);
	expect(upstream).not.toHaveBeenCalled();
	expect((await send("/api/ci")).status).toBe(200);
	expect(upstream.mock.lastCall?.[0]).toBe("https://giraffe.hexly.ai/api/ci");
});

it("rejects oversized bodies and foreign hosts before upstream access", async () => {
	const { send, upstream, token } = await fixture();
	expect((await send("/api/accounts", "POST", "x".repeat(2 * 1024 * 1024 + 1))).status).toBe(413);
	expect((await send("/api/repos", "GET", undefined, "evil.test")).status).toBe(403);
	expect(upstream).not.toHaveBeenCalled();
	expect(token).not.toHaveBeenCalled();
});

it("streams empty replies and masks invalid HTTP request construction failures", async () => {
	const { send, upstream } = await fixture();
	upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
	expect(await send("/api/repos")).toEqual({ status: 204, body: "" });
	expect((await send("/api/repos", "TRACE")).status).toBe(502);
});
